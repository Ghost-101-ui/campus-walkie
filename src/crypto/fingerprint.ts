/**
 * Pairwise "safety words" - a short authentication string two people can read to
 * each other out loud to confirm they are talking to the intended peer and not to
 * something in the middle.
 *
 *   material = SHA-256( utf8( min(pubA,pubB) || "|" || max(pubA,pubB) ) )
 *   take the first 55 bits -> five 11-bit indices -> five BIP-39 words
 *
 * Sorting makes the value identical on both ends without either side having to
 * know who "started" the connection. 55 bits means a forger needs ~2^55 tries to
 * produce a colliding key pair; that is deliberately more work than a session
 * lasts, but it is a human-verified check, not a cryptographic binding on its own.
 * The real MITM defence is that all SDP is sealed with the channel key
 * (see THREAT-MODEL.md); the safety words let humans confirm it.
 */

import { sha256, utf8 } from './bytes';
import { WORDLIST } from './wordlist';

export const WORD_COUNT = 5;
const BITS_PER_WORD = 11;

/** Five BIP-39 words identifying the pair (pubA, pubB). Order-independent. */
export async function safetyWords(pubA: string, pubB: string): Promise<string[]> {
  const [lo, hi] = pubA <= pubB ? [pubA, pubB] : [pubB, pubA];
  const digest = await sha256(utf8(`${lo}|${hi}`));
  return wordsFromBits(digest);
}

/**
 * Read WORD_COUNT * 11 = 55 bits big-endian out of `digest` and map each 11-bit
 * group to a word. Exported for the unit tests.
 */
export function wordsFromBits(digest: Uint8Array): string[] {
  const out: string[] = [];
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < WORD_COUNT) {
    if (bits < BITS_PER_WORD) {
      acc = (acc << 8) | (digest[i++] ?? 0);
      bits += 8;
      continue;
    }
    const shift = bits - BITS_PER_WORD;
    const index = (acc >> shift) & 0x7ff;
    acc &= (1 << shift) - 1;
    bits = shift;
    out.push(WORDLIST[index] ?? '?');
  }
  return out;
}
