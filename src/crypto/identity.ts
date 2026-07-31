/**
 * Per-session signing identity, signed envelopes, and replay protection.
 *
 * Primary algorithm: Ed25519 (RFC 8032), via the WebCrypto "Ed25519" algorithm
 * (Secure Curves in WebCrypto). Supported in Safari 17+, Firefox 130+, Chrome 137+.
 * Where it is missing (notably older Chrome/Android and Safari 16) we fall back to
 * ECDSA P-256 with SHA-256 (FIPS 186-4 / RFC 6979-free, WebCrypto "ECDSA"), which
 * has been everywhere for a decade. Which one was used is recorded on the identity
 * and shown in the Verify sheet.
 *
 * Keys are generated per session and are non-extractable. Nothing is persisted:
 * closing the tab destroys the identity, which is the point - `peerId` is stable
 * for a session and unlinkable across sessions.
 */

import { b64u, sha256, unb64u, utf8 } from './bytes';

export type SigAlg = 'Ed25519' | 'ECDSA-P256';

/** SPKI DER length of an Ed25519 public key. P-256 SPKI is 91 bytes. */
const ED25519_SPKI_LEN = 44;

/** Reject envelopes whose timestamp is further than this from local time. */
export const MAX_CLOCK_SKEW_MS = 60_000;

export interface Identity {
  readonly alg: SigAlg;
  /** First 16 base64url chars of SHA-256(SPKI public key). */
  readonly peerId: string;
  /** base64url SPKI public key, sent in every envelope. */
  readonly pub: string;
  readonly privateKey: CryptoKey;
}

export interface Envelope<B = unknown> {
  readonly v: 1;
  readonly from: string;
  readonly ts: number;
  readonly seq: number;
  readonly pub: string;
  readonly sig: string;
  readonly body: B;
}

function algParams(alg: SigAlg): EcKeyGenParams | Algorithm {
  return alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
}

function signParams(alg: SigAlg): AlgorithmIdentifier | EcdsaParams {
  return alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
}

/** Detect the algorithm from the SPKI length. Ed25519 SPKI is always 44 bytes. */
export function algFromPub(pub: string): SigAlg {
  return unb64u(pub).length === ED25519_SPKI_LEN ? 'Ed25519' : 'ECDSA-P256';
}

/** True if this browser can generate Ed25519 keys. */
export async function supportsEd25519(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a fresh, non-extractable session identity.
 * Tries Ed25519 first, falls back to ECDSA P-256/SHA-256.
 */
export async function createIdentity(): Promise<Identity> {
  let alg: SigAlg = 'Ed25519';
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey(algParams(alg), false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  } catch {
    alg = 'ECDSA-P256';
    pair = (await crypto.subtle.generateKey(algParams(alg), false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  }
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pub = b64u(spki);
  const peerId = b64u(await sha256(spki)).slice(0, 16);
  return { alg, peerId, pub, privateKey: pair.privateKey };
}

/**
 * Canonical bytes covered by `sig`:
 *   channelId "|" from "|" ts "|" seq "|" JSON(body)
 * Field-separated so no two different field splits can produce the same string.
 */
export function signingBytes(
  channelId: string,
  from: string,
  ts: number,
  seq: number,
  body: unknown,
): Uint8Array {
  return utf8(`${channelId}|${from}|${ts}|${seq}|${JSON.stringify(body)}`);
}

/** Monotonic per-identity sequence numbers. One counter per Identity object. */
const seqCounters = new WeakMap<Identity, number>();

/** Next sequence number for this identity, starting at 1. */
export function nextSeq(id: Identity): number {
  const n = (seqCounters.get(id) ?? 0) + 1;
  seqCounters.set(id, n);
  return n;
}

/** Build and sign an envelope around `body`. */
export async function makeEnvelope<B>(
  id: Identity,
  channelId: string,
  body: B,
  now: number = Date.now(),
): Promise<Envelope<B>> {
  const seq = nextSeq(id);
  const sig = b64u(
    await crypto.subtle.sign(
      signParams(id.alg),
      id.privateKey,
      signingBytes(channelId, id.peerId, now, seq, body) as unknown as BufferSource,
    ),
  );
  return { v: 1, from: id.peerId, ts: now, seq, pub: id.pub, sig, body };
}

export type VerifyReason =
  | 'ok'
  | 'bad-shape'
  | 'bad-version'
  | 'peer-id-mismatch'
  | 'pub-changed'
  | 'stale-timestamp'
  | 'replayed-seq'
  | 'bad-signature';

export interface VerifyResult<B> {
  ok: boolean;
  reason: VerifyReason;
  env?: Envelope<B>;
}

interface PeerRecord {
  pub: string;
  lastSeq: number;
}

/**
 * Tracks the public key and highest sequence number seen per peer.
 * In memory only, one instance per channel session.
 */
export class ReplayGuard {
  private peers = new Map<string, PeerRecord>();

  known(peerId: string): PeerRecord | undefined {
    return this.peers.get(peerId);
  }

  /** Called only after a signature has verified. */
  accept(peerId: string, pub: string, seq: number): void {
    this.peers.set(peerId, { pub, lastSeq: seq });
  }

  forget(peerId: string): void {
    this.peers.delete(peerId);
  }

  clear(): void {
    this.peers.clear();
  }
}

function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e['from'] === 'string' &&
    typeof e['ts'] === 'number' &&
    typeof e['seq'] === 'number' &&
    typeof e['pub'] === 'string' &&
    typeof e['sig'] === 'string' &&
    'body' in e
  );
}

/**
 * Verify an envelope: shape, claimed peer id vs public key, key continuity,
 * clock skew, strictly increasing seq, then the signature itself.
 *
 * Order matters: the cheap checks run first so a flood of garbage cannot make us
 * do 1 000 signature verifications. `guard` is only updated on full success.
 */
export async function verifyEnvelope<B = unknown>(
  channelId: string,
  raw: unknown,
  guard: ReplayGuard,
  now: number = Date.now(),
): Promise<VerifyResult<B>> {
  if (!isEnvelope(raw)) return { ok: false, reason: 'bad-shape' };
  if (raw.v !== 1) return { ok: false, reason: 'bad-version' };
  const env = raw as Envelope<B>;

  let spki: Uint8Array;
  try {
    spki = unb64u(env.pub);
  } catch {
    return { ok: false, reason: 'bad-shape' };
  }

  const expectedId = b64u(await sha256(spki)).slice(0, 16);
  if (expectedId !== env.from) return { ok: false, reason: 'peer-id-mismatch' };

  const prev = guard.known(env.from);
  if (prev && prev.pub !== env.pub) return { ok: false, reason: 'pub-changed' };
  if (Math.abs(env.ts - now) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale-timestamp' };
  if (prev && env.seq <= prev.lastSeq) return { ok: false, reason: 'replayed-seq' };

  const alg = algFromPub(env.pub);
  let pubKey: CryptoKey;
  try {
    pubKey = await crypto.subtle.importKey('spki', spki as unknown as BufferSource, algParams(alg), true, ['verify']);
  } catch {
    return { ok: false, reason: 'bad-shape' };
  }

  let good = false;
  try {
    good = await crypto.subtle.verify(
      signParams(alg),
      pubKey,
      unb64u(env.sig) as unknown as BufferSource,
      signingBytes(channelId, env.from, env.ts, env.seq, env.body) as unknown as BufferSource,
    );
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad-signature' };

  guard.accept(env.from, env.pub, env.seq);
  return { ok: true, reason: 'ok', env };
}
