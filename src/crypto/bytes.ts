/**
 * Byte / string helpers shared by the crypto modules.
 *
 * base64url is the unpadded URL-safe alphabet of RFC 4648 §5.
 * Everything here is constant-time-irrelevant (no secrets are compared) and
 * deliberately boring so it can be read against the spec line by line.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** UTF-8 encode a string. */
export function utf8(s: string): Uint8Array {
  return ENC.encode(s);
}

/** UTF-8 decode bytes. Throws on invalid UTF-8. */
export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

/** Lossy UTF-8 decode, for debug output only. */
export function fromUtf8Lossy(b: Uint8Array): string {
  return DEC.decode(b);
}

/** Encode bytes as unpadded base64url (RFC 4648 §5). */
export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  // 8 KiB chunks: String.fromCharCode(...spread) blows the stack on big inputs.
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode unpadded base64url (RFC 4648 §5). Throws on invalid input. */
export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Concatenate byte arrays into one buffer. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SHA-256 (FIPS 180-4) over bytes. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
}

/** Overwrite a buffer with zeroes. Best effort: the GC may already have copied it. */
export function zero(b: Uint8Array): void {
  b.fill(0);
}
