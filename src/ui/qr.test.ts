import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeQr } from './qr';

/**
 * The encoder is hand-written, so it is verified against an independent decoder
 * (jsqr, a dev dependency - it never ships in the bundle). If these pass, the codes
 * a phone camera sees are real.
 */
function decode(text: string): string | null {
  const qr = encodeQr(text);
  const quiet = 4;
  const scale = 4;
  const side = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r]?.[c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const i = (y * side + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, side, side)?.data ?? null;
}

describe('qr encoder', () => {
  it('produces the right matrix size and finder patterns', () => {
    const qr = encodeQr('https://example.com/#hostel-c');
    expect(qr.size).toBe(17 + qr.version * 4);
    for (const [r, c] of [
      [0, 0],
      [0, qr.size - 7],
      [qr.size - 7, 0],
    ] as const) {
      expect(qr.modules[r]?.[c]).toBe(true); // finder outer ring
      expect(qr.modules[r + 1]?.[c + 1]).toBe(false); // light ring
      expect(qr.modules[r + 3]?.[c + 3]).toBe(true); // 3x3 core
    }
  });

  it('round-trips through an independent decoder', () => {
    for (const text of [
      'https://you.github.io/campus-walkie/#hostel-c',
      'https://you.github.io/campus-walkie/#lab%20crew%20%F0%9F%8E%99',
      'a',
      'x'.repeat(120),
    ]) {
      expect(decode(text)).toBe(text);
    }
  });

  it('scales up through the version range', () => {
    const small = encodeQr('a');
    const big = encodeQr('x'.repeat(200));
    expect(small.version).toBe(1);
    expect(big.version).toBeGreaterThanOrEqual(9);
    expect(decode('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('throws instead of emitting an unscannable code when the text is too long', () => {
    expect(() => encodeQr('x'.repeat(400))).toThrow(/does not fit/);
  });
});
