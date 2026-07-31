/**
 * AEAD wire format. AES-GCM-256 (NIST SP 800-38D) via WebCrypto.
 *
 *   seal(obj):  iv   = 12 random bytes from crypto.getRandomValues
 *               pt   = UTF8(JSON.stringify(obj))
 *               ct   = AES-GCM(channelKey, iv, pt, aad = UTF8(channelId))   // ct includes the 16-byte tag
 *               wire = base64url(iv || ct)
 *
 *   open(wire): the reverse. Any failure THROWS. There is no plaintext fallback,
 *               ever - a message that will not open is a message we never saw.
 *
 * The 12-byte IV is random per message (SP 800-38D §8.2.2). With a 96-bit random
 * IV the safe limit is far beyond anything a walkie-talkie channel will send, and
 * a fresh key is derived per channel.
 */

import { b64u, concat, fromUtf8, unb64u, utf8 } from './bytes';

export const IV_LEN = 12;
/** GCM tag length in bits (NIST SP 800-38D §5.2.1.2 recommends 128). */
export const TAG_BITS = 128;

let openFailures = 0;

/** Number of `open` failures since page load. Surfaced in the debug ring buffer. */
export function aeadOpenFailures(): number {
  return openFailures;
}

/** Thrown by {@link open} on a bad tag, bad key, bad AAD, or malformed wire bytes. */
export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

/**
 * Encrypt a JSON-serialisable value. Returns the base64url wire string.
 * @param key non-extractable AES-GCM-256 key from the KDF
 * @param channelId used verbatim as the additional authenticated data
 */
export async function seal(key: CryptoKey, channelId: string, obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const pt = utf8(JSON.stringify(obj));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: utf8(channelId) as unknown as BufferSource, tagLength: TAG_BITS },
      key,
      pt as unknown as BufferSource,
    ),
  );
  return b64u(concat(iv, ct));
}

/**
 * Decrypt and JSON-parse a wire string.
 * @throws AeadError on any failure - tampering, wrong key, wrong channel id, garbage input.
 */
export async function open<T = unknown>(
  key: CryptoKey,
  channelId: string,
  wire: string,
): Promise<T> {
  let raw: Uint8Array;
  try {
    raw = unb64u(wire);
  } catch {
    openFailures++;
    throw new AeadError('not base64url');
  }
  if (raw.length <= IV_LEN + TAG_BITS / 8) {
    openFailures++;
    throw new AeadError('too short');
  }
  const iv = raw.subarray(0, IV_LEN);
  const ct = raw.subarray(IV_LEN);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: utf8(channelId) as unknown as BufferSource, tagLength: TAG_BITS },
      key,
      ct as unknown as BufferSource,
    );
  } catch {
    openFailures++;
    throw new AeadError('authentication failed');
  }
  try {
    return JSON.parse(fromUtf8(new Uint8Array(pt))) as T;
  } catch {
    openFailures++;
    throw new AeadError('plaintext is not JSON');
  }
}
