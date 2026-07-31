import { describe, expect, it } from 'vitest';
import { b64u, unb64u, utf8, sha256 } from './bytes';
import {
  CHANNEL_ID_LEN,
  KDF_ITERATIONS,
  deriveChannelKeys,
  deriveSalt,
  normaliseChannelName,
  normalisePassphrase,
} from './kdf';
import { AeadError, open, seal } from './aead';
import {
  MAX_CLOCK_SKEW_MS,
  ReplayGuard,
  createIdentity,
  makeEnvelope,
  signingBytes,
  verifyEnvelope,
  type Envelope,
} from './identity';
import { safetyWords, wordsFromBits } from './fingerprint';
import { WORDLIST } from './wordlist';

// Tests use a low iteration count for speed. One test pins the production value.
const IT = 1_000;

describe('bytes', () => {
  it('round-trips base64url without padding', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 64, 1000]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      const s = b64u(bytes);
      expect(s).not.toMatch(/[+/=]/);
      expect([...unb64u(s)]).toEqual([...bytes]);
    }
  });

  it('rejects non-base64url input', () => {
    expect(() => unb64u('not valid!!')).toThrow();
  });
});

describe('kdf', () => {
  it('pins the production parameters', () => {
    expect(KDF_ITERATIONS).toBe(600_000);
    expect(CHANNEL_ID_LEN).toBe(22);
  });

  it('normalises the channel name but not the passphrase', () => {
    expect(normaliseChannelName('  Hostel   C ')).toBe('hostel c');
    expect(normalisePassphrase('  Secret ')).toBe('  Secret ');
  });

  it('derives a 32-byte salt bound to the channel name', async () => {
    const a = await deriveSalt('hostel c');
    const b = await deriveSalt('HOSTEL   C');
    const c = await deriveSalt('hostel d');
    expect(a.length).toBe(32);
    expect([...a]).toEqual([...b]);
    expect([...a]).not.toEqual([...c]);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await deriveChannelKeys('hostel c', 'correct horse battery', IT);
    const b = await deriveChannelKeys('Hostel C', 'correct horse battery', IT);
    expect(a.channelId).toBe(b.channelId);
    expect(a.channelId.length).toBe(CHANNEL_ID_LEN);
    // Same key: a message sealed by one opens with the other.
    const wire = await seal(a.channelKey, a.channelId, { hi: 1 });
    expect(await open(b.channelKey, b.channelId, wire)).toEqual({ hi: 1 });
  });

  it('changes when the channel changes', async () => {
    const a = await deriveChannelKeys('hostel c', 'pw', IT);
    const b = await deriveChannelKeys('hostel d', 'pw', IT);
    expect(a.channelId).not.toBe(b.channelId);
  });

  it('changes when the passphrase changes, including case and whitespace', async () => {
    const a = await deriveChannelKeys('c', 'pw', IT);
    const b = await deriveChannelKeys('c', 'PW', IT);
    const c = await deriveChannelKeys('c', ' pw', IT);
    expect(new Set([a.channelId, b.channelId, c.channelId]).size).toBe(3);
  });

  it('treats NFKC-equivalent passphrases as equal and different codepoints as different', async () => {
    // U+FB01 LATIN SMALL LIGATURE FI normalises to "fi" under NFKC.
    const ligature = await deriveChannelKeys('c', '\uFB01re', IT);
    const plain = await deriveChannelKeys('c', 'fire', IT);
    expect(ligature.channelId).toBe(plain.channelId);

    const other = await deriveChannelKeys('c', 'f\u0131re', IT); // dotless i
    expect(other.channelId).not.toBe(plain.channelId);
  });

  it('produces a non-extractable AES-GCM key', async () => {
    const { channelKey } = await deriveChannelKeys('c', 'pw', IT);
    expect(channelKey.extractable).toBe(false);
    expect(channelKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(new Set(channelKey.usages)).toEqual(new Set(['encrypt', 'decrypt']));
    await expect(crypto.subtle.exportKey('raw', channelKey)).rejects.toThrow();
  });
});

describe('aead', () => {
  it('round-trips objects of every shape', async () => {
    const { channelKey, channelId } = await deriveChannelKeys('c', 'pw', IT);
    for (const obj of [
      { k: 'text', body: 'hello' },
      { nested: { a: [1, 2, 3], b: null } },
      'plain string',
      42,
      { unicode: 'नमस्ते 🎙' },
    ]) {
      const wire = await seal(channelKey, channelId, obj);
      expect(await open(channelKey, channelId, wire)).toEqual(obj);
    }
  });

  it('uses a fresh iv per message', async () => {
    const { channelKey, channelId } = await deriveChannelKeys('c', 'pw', IT);
    const a = await seal(channelKey, channelId, { x: 1 });
    const b = await seal(channelKey, channelId, { x: 1 });
    expect(a).not.toBe(b);
    expect(unb64u(a).subarray(0, 12)).not.toEqual(unb64u(b).subarray(0, 12));
  });

  it('throws on a flipped ciphertext bit', async () => {
    const { channelKey, channelId } = await deriveChannelKeys('c', 'pw', IT);
    const raw = unb64u(await seal(channelKey, channelId, { x: 1 }));
    raw[20] = (raw[20] ?? 0) ^ 0x01;
    await expect(open(channelKey, channelId, b64u(raw))).rejects.toBeInstanceOf(AeadError);
  });

  it('throws on a flipped tag bit', async () => {
    const { channelKey, channelId } = await deriveChannelKeys('c', 'pw', IT);
    const raw = unb64u(await seal(channelKey, channelId, { x: 1 }));
    const idx = raw.length - 1;
    raw[idx] = (raw[idx] ?? 0) ^ 0x80;
    await expect(open(channelKey, channelId, b64u(raw))).rejects.toBeInstanceOf(AeadError);
  });

  it('throws on the wrong key', async () => {
    const a = await deriveChannelKeys('c', 'pw', IT);
    const b = await deriveChannelKeys('c', 'other pw', IT);
    const wire = await seal(a.channelKey, a.channelId, { x: 1 });
    await expect(open(b.channelKey, a.channelId, wire)).rejects.toBeInstanceOf(AeadError);
  });

  it('throws on the wrong aad', async () => {
    const { channelKey, channelId } = await deriveChannelKeys('c', 'pw', IT);
    const wire = await seal(channelKey, channelId, { x: 1 });
    await expect(open(channelKey, channelId + 'x', wire)).rejects.toBeInstanceOf(AeadError);
  });

  it('throws on truncated and non-base64url wire data', async () => {
    const { channelKey, channelId } = await deriveChannelKeys('c', 'pw', IT);
    await expect(open(channelKey, channelId, 'AAAA')).rejects.toBeInstanceOf(AeadError);
    await expect(open(channelKey, channelId, '!!!!')).rejects.toBeInstanceOf(AeadError);
  });
});

describe('identity + envelopes', () => {
  const CH = 'test-channel-id-000000';

  it('derives peerId from the public key', async () => {
    const id = await createIdentity();
    expect(id.peerId.length).toBe(16);
    expect(b64u(await sha256(unb64u(id.pub))).slice(0, 16)).toBe(id.peerId);
    expect(['Ed25519', 'ECDSA-P256']).toContain(id.alg);
  });

  it('is random across sessions', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    expect(a.peerId).not.toBe(b.peerId);
  });

  it('accepts its own envelopes and increments seq', async () => {
    const id = await createIdentity();
    const guard = new ReplayGuard();
    const e1 = await makeEnvelope(id, CH, { k: 'text', body: 'one' });
    const e2 = await makeEnvelope(id, CH, { k: 'text', body: 'two' });
    expect(e2.seq).toBe(e1.seq + 1);
    expect((await verifyEnvelope(CH, e1, guard)).ok).toBe(true);
    expect((await verifyEnvelope(CH, e2, guard)).ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const id = await createIdentity();
    const env = await makeEnvelope(id, CH, { k: 'text', body: 'pay alice' });
    const evil = { ...env, body: { k: 'text', body: 'pay bob' } };
    const r = await verifyEnvelope(CH, evil, new ReplayGuard());
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a tampered ts inside the skew window', async () => {
    const id = await createIdentity();
    const env = await makeEnvelope(id, CH, { k: 'ping' });
    const evil = { ...env, ts: env.ts - 5_000 };
    const r = await verifyEnvelope(CH, evil, new ReplayGuard());
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a swapped pub (peer id mismatch)', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const env = await makeEnvelope(a, CH, { k: 'ping' });
    const evil = { ...env, pub: b.pub };
    const r = await verifyEnvelope(CH, evil, new ReplayGuard());
    expect(r).toMatchObject({ ok: false, reason: 'peer-id-mismatch' });
  });

  it('rejects a swapped pub with a matching forged signature (peer id mismatch)', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const guard = new ReplayGuard();
    const first = await makeEnvelope(a, CH, { k: 'ping' });
    expect((await verifyEnvelope(CH, first, guard)).ok).toBe(true);
    // b signs correctly but claims a's peerId. Because peerId = H(pub), the id
    // check catches this before any signature work is done.
    const forged = await makeEnvelope(b, CH, { k: 'ping' });
    const evil: Envelope = { ...forged, from: a.peerId };
    expect(await verifyEnvelope(CH, evil, guard)).toMatchObject({
      ok: false,
      reason: 'peer-id-mismatch',
    });
  });

  it('rejects a key change for an established peer', async () => {
    // Defence in depth: even if the peerId<->pub binding were ever loosened, a
    // peer that turns up with a different key mid-session is rejected.
    const a = await createIdentity();
    const guard = new ReplayGuard();
    guard.accept(a.peerId, 'some-other-pub', 0);
    const env = await makeEnvelope(a, CH, { k: 'ping' });
    expect(await verifyEnvelope(CH, env, guard)).toMatchObject({
      ok: false,
      reason: 'pub-changed',
    });
  });

  it('rejects a signature made for a different channel', async () => {
    const id = await createIdentity();
    const env = await makeEnvelope(id, 'other-channel-id-00000', { k: 'ping' });
    const r = await verifyEnvelope(CH, env, new ReplayGuard());
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a replayed seq', async () => {
    const id = await createIdentity();
    const guard = new ReplayGuard();
    const env = await makeEnvelope(id, CH, { k: 'ping' });
    expect((await verifyEnvelope(CH, env, guard)).ok).toBe(true);
    const r = await verifyEnvelope(CH, env, guard);
    expect(r).toMatchObject({ ok: false, reason: 'replayed-seq' });
  });

  it('rejects a non-increasing seq even with a valid signature', async () => {
    const id = await createIdentity();
    const guard = new ReplayGuard();
    const e1 = await makeEnvelope(id, CH, { k: 'a' });
    const e2 = await makeEnvelope(id, CH, { k: 'b' });
    expect((await verifyEnvelope(CH, e2, guard)).ok).toBe(true);
    const r = await verifyEnvelope(CH, e1, guard);
    expect(r).toMatchObject({ ok: false, reason: 'replayed-seq' });
  });

  it('rejects a ts skewed by 90 s in both directions', async () => {
    const id = await createIdentity();
    const now = Date.now();
    const old = await makeEnvelope(id, CH, { k: 'ping' }, now - 90_000);
    const future = await makeEnvelope(id, CH, { k: 'ping' }, now + 90_000);
    expect(await verifyEnvelope(CH, old, new ReplayGuard(), now)).toMatchObject({
      ok: false,
      reason: 'stale-timestamp',
    });
    expect(await verifyEnvelope(CH, future, new ReplayGuard(), now)).toMatchObject({
      ok: false,
      reason: 'stale-timestamp',
    });
    // Inside the window is fine.
    const edge = await makeEnvelope(id, CH, { k: 'ping' }, now - (MAX_CLOCK_SKEW_MS - 1_000));
    expect((await verifyEnvelope(CH, edge, new ReplayGuard(), now)).ok).toBe(true);
  });

  it('rejects malformed input without throwing', async () => {
    const guard = new ReplayGuard();
    for (const junk of [null, 42, 'x', {}, { v: 2, from: 'a', ts: 0, seq: 1, pub: '', sig: '' }]) {
      const r = await verifyEnvelope(CH, junk, guard);
      expect(r.ok).toBe(false);
    }
  });

  it('signs canonical bytes that are field-separated', () => {
    const a = signingBytes('ch', 'peer', 1, 2, { x: 1 });
    const b = signingBytes('ch', 'peer', 1, 2, { x: 2 });
    expect(a).not.toEqual(b);
    expect(new TextDecoder().decode(a)).toBe('ch|peer|1|2|{"x":1}');
  });
});

describe('safety words', () => {
  it('is order-independent and 5 words long', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const w1 = await safetyWords(a.pub, b.pub);
    const w2 = await safetyWords(b.pub, a.pub);
    expect(w1).toEqual(w2);
    expect(w1).toHaveLength(5);
    for (const w of w1) expect(WORDLIST).toContain(w);
  });

  it('differs for a different peer', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const c = await createIdentity();
    expect(await safetyWords(a.pub, b.pub)).not.toEqual(await safetyWords(a.pub, c.pub));
  });

  it('maps bits to indices big-endian', () => {
    // 0x00 0x00 ... -> index 0 five times
    expect(wordsFromBits(new Uint8Array(8))).toEqual(Array(5).fill(WORDLIST[0]));
    // all ones -> index 2047 five times
    expect(wordsFromBits(new Uint8Array(8).fill(0xff))).toEqual(Array(5).fill(WORDLIST[2047]));
  });

  it('has exactly 2048 words', () => {
    expect(WORDLIST).toHaveLength(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(utf8(WORDLIST[0] ?? '').length).toBeGreaterThan(0);
  });
});
