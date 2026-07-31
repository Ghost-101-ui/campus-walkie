/**
 * Passphrase -> channel keys.
 *
 * Exactly the construction from the spec, no substitutions:
 *
 *   salt       = SHA-256("campus-walkie:v1:salt:" || channelName_normalised)
 *   master     = PBKDF2-HMAC-SHA-256(NFKC(passphrase), salt, 600_000, 64 bytes)
 *   channelKey = master[0..32)   AES-GCM-256, extractable: false
 *   idKey      = master[32..64)  HMAC-SHA-256
 *   channelId  = base64url(HMAC-SHA-256(idKey, "campus-walkie:v1:channel-id")).slice(0, 22)
 *
 * References:
 *  - PBKDF2: RFC 8018 §5.2 (PKCS #5 v2.1)
 *  - HMAC: RFC 2104 / FIPS 198-1
 *  - SHA-256: FIPS 180-4
 *  - AES-GCM: NIST SP 800-38D
 *  - WebCrypto algorithm names: https://w3c.github.io/webcrypto/
 */

import { b64u, sha256, utf8, zero } from './bytes';

/** Domain separation prefix for the salt. Changing it invalidates every channel. */
export const SALT_PREFIX = 'campus-walkie:v1:salt:';

/** Domain separation label for the channel id HMAC. */
export const CHANNEL_ID_LABEL = 'campus-walkie:v1:channel-id';

/** PBKDF2 iteration count. ~1-2 s on a mid-range Android phone. */
export const KDF_ITERATIONS = 600_000;

/** Length of the base64url channel id in characters (132 bits of the HMAC output). */
export const CHANNEL_ID_LEN = 22;

export interface ChannelKeys {
  /** AES-GCM-256 key, non-extractable, usages encrypt+decrypt. */
  readonly channelKey: CryptoKey;
  /** Public routing id for the relay. Reveals nothing about name or passphrase. */
  readonly channelId: string;
  /** Iterations actually used (tests lower it; production is KDF_ITERATIONS). */
  readonly iterations: number;
}

/**
 * Canonical channel name: trimmed, lower-cased, NFKC.
 * Two people typing "Hostel  C" and "hostel c" must NOT land in different rooms,
 * so whitespace runs collapse to a single space as well.
 */
export function normaliseChannelName(channelName: string): string {
  return channelName.trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFKC');
}

/**
 * Canonical passphrase: NFKC only. Never trimmed, never lower-cased - a leading
 * space or a capital letter is entropy the user chose to spend.
 */
export function normalisePassphrase(passphrase: string): string {
  return passphrase.normalize('NFKC');
}

/** salt = SHA-256(SALT_PREFIX || normalised channel name). 32 bytes. */
export async function deriveSalt(channelName: string): Promise<Uint8Array> {
  return sha256(utf8(SALT_PREFIX + normaliseChannelName(channelName)));
}

/**
 * Derive the channel key material. CPU-bound by design - call it from a Worker
 * (see `deriveChannelKeysInWorker`) so the UI thread stays responsive.
 *
 * @param channelName raw user input
 * @param passphrase raw user input
 * @param iterations override for tests only; production must use KDF_ITERATIONS
 */
export async function deriveChannelKeys(
  channelName: string,
  passphrase: string,
  iterations: number = KDF_ITERATIONS,
): Promise<ChannelKeys> {
  const salt = await deriveSalt(channelName);

  const pw = utf8(normalisePassphrase(passphrase));
  const pwKey = await crypto.subtle.importKey('raw', pw as unknown as BufferSource, 'PBKDF2', false, ['deriveBits']);
  zero(pw);

  const masterBuf = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    pwKey,
    64 * 8,
  );
  const master = new Uint8Array(masterBuf);

  const channelKey = await crypto.subtle.importKey(
    'raw',
    master.subarray(0, 32) as unknown as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false, // extractable: false
    ['encrypt', 'decrypt'],
  );

  const idKey = await crypto.subtle.importKey(
    'raw',
    master.subarray(32, 64) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  zero(master);

  const idMac = await crypto.subtle.sign('HMAC', idKey, utf8(CHANNEL_ID_LABEL) as unknown as BufferSource);
  const channelId = b64u(new Uint8Array(idMac)).slice(0, CHANNEL_ID_LEN);

  return { channelKey, channelId, iterations };
}

export interface WorkerProgress {
  /** Milliseconds the worker measured for a 5 000-iteration calibration run. */
  calibrationMs: number;
  /** Extrapolated total time for the real derivation. An estimate, not a promise. */
  estimateMs: number;
}

/**
 * Run the KDF on a Worker thread.
 *
 * PBKDF2 in WebCrypto is atomic: it cannot report progress mid-flight, and
 * splitting it into chunks would change the output. So the worker times a short
 * calibration derivation first and hands back an estimate; the UI animates a
 * determinate bar from that and snaps to 100% when the real key arrives.
 *
 * The returned `CryptoKey` is structured-cloned across the thread boundary and
 * stays non-extractable on both sides.
 */
export function deriveChannelKeysInWorker(
  channelName: string,
  passphrase: string,
  onEstimate?: (p: WorkerProgress) => void,
  iterations: number = KDF_ITERATIONS,
): Promise<ChannelKeys> {
  return new Promise<ChannelKeys>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      // No module-worker support: fall back to the main thread. Slower UI, same crypto.
      deriveChannelKeys(channelName, passphrase, iterations).then(resolve, reject);
      void err;
      return;
    }
    const done = (fn: () => void) => {
      worker.terminate();
      fn();
    };
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as
        | { t: 'estimate'; calibrationMs: number; estimateMs: number }
        | { t: 'ok'; channelKey: CryptoKey; channelId: string; iterations: number }
        | { t: 'err'; message: string };
      if (msg.t === 'estimate') {
        onEstimate?.({ calibrationMs: msg.calibrationMs, estimateMs: msg.estimateMs });
      } else if (msg.t === 'ok') {
        done(() =>
          resolve({
            channelKey: msg.channelKey,
            channelId: msg.channelId,
            iterations: msg.iterations,
          }),
        );
      } else {
        done(() => reject(new Error(msg.message)));
      }
    };
    worker.onerror = (ev) => done(() => reject(new Error(ev.message || 'kdf worker failed')));
    worker.postMessage({ channelName, passphrase, iterations });
  });
}
