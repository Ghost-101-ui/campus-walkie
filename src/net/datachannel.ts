/**
 * Data channel framing, chunking, reassembly and backpressure.
 *
 * Peer-to-peer data is already encrypted by DTLS, but we seal it with the channel
 * key anyway so that one code path serves both transports (direct data channel and
 * relay fallback) and so a future transport cannot accidentally be the plaintext
 * one.
 *
 * Wire shape per message: Frame -> JSON -> seal() -> one data channel send.
 * Payloads larger than a chunk are split into `chunk` frames, each carrying a
 * base64url slice of at most 12 KB.
 */

import { b64u, concat, unb64u } from '../crypto/bytes';
import type { Frame } from '../types';

/** Raw bytes per chunk. base64url of 9 216 bytes is exactly 12 288 chars (12 KB). */
export const RAW_CHUNK_BYTES = 9 * 1024;
/** Encoded chunk ceiling, asserted by the tests. */
export const MAX_CHUNK_CHARS = 12 * 1024;
/** Incomplete transfers are dropped after this long. */
export const REASSEMBLY_TTL_MS = 60_000;
/** Stop feeding the data channel above this much buffered data. */
export const BUFFER_HIGH = 512 * 1024;
/** Resume when the channel drains to here. */
export const BUFFER_LOW = 128 * 1024;

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
}

/** How many chunks a payload of `size` bytes needs. */
export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / RAW_CHUNK_BYTES));
}

/** Metadata frame describing a payload that is about to be chunked. */
export function fileFrame(id: string, name: string, mime: string, size: number): Frame {
  return { k: 'file', id, name, mime, size, chunks: chunkCount(size) };
}

/** Split a payload into `chunk` frames. */
export function splitPayload(id: string, bytes: Uint8Array): Frame[] {
  const out: Frame[] = [];
  for (let i = 0, n = 0; i < bytes.length || n === 0; i += RAW_CHUNK_BYTES, n++) {
    out.push({ k: 'chunk', id, i: n, d: b64u(bytes.subarray(i, i + RAW_CHUNK_BYTES)) });
    if (i + RAW_CHUNK_BYTES >= bytes.length) break;
  }
  return out;
}

interface Pending {
  meta: FileMeta;
  parts: Map<number, Uint8Array>;
  started: number;
  received: number;
}

export interface Completed {
  meta: FileMeta;
  bytes: Uint8Array;
}

/**
 * Collects `chunk` frames into whole payloads, keyed by `peerId|transferId`.
 * Out-of-order arrival is fine; a transfer with a missing chunk is dropped by
 * {@link sweep} once its TTL passes.
 */
export class Reassembler {
  private pending = new Map<string, Pending>();

  private static key(peerId: string, id: string): string {
    return `${peerId}|${id}`;
  }

  /** Register an incoming transfer. Returns false if the metadata is unusable. */
  begin(peerId: string, meta: FileMeta, now: number = Date.now()): boolean {
    if (meta.chunks < 1 || meta.size < 0 || meta.chunks !== chunkCount(meta.size)) return false;
    this.pending.set(Reassembler.key(peerId, meta.id), {
      meta,
      parts: new Map(),
      started: now,
      received: 0,
    });
    return true;
  }

  /**
   * Add a chunk. Returns the finished payload when the last missing piece
   * arrives, `null` while incomplete, and throws only on a chunk for an unknown
   * transfer (the caller logs and ignores that).
   */
  push(peerId: string, frame: Extract<Frame, { k: 'chunk' }>): Completed | null {
    const key = Reassembler.key(peerId, frame.id);
    const p = this.pending.get(key);
    if (!p) return null;
    if (frame.i < 0 || frame.i >= p.meta.chunks || p.parts.has(frame.i)) return null;
    let bytes: Uint8Array;
    try {
      bytes = unb64u(frame.d);
    } catch {
      return null;
    }
    p.parts.set(frame.i, bytes);
    p.received += bytes.length;
    if (p.received > p.meta.size) {
      // A peer claiming 1 MB and sending 10 MB. Drop the whole transfer.
      this.pending.delete(key);
      return null;
    }
    if (p.parts.size !== p.meta.chunks) return null;

    const ordered: Uint8Array[] = [];
    for (let i = 0; i < p.meta.chunks; i++) ordered.push(p.parts.get(i) ?? new Uint8Array(0));
    this.pending.delete(key);
    return { meta: p.meta, bytes: concat(...ordered) };
  }

  /** Progress 0-1 for a transfer, or null if it is not in flight. */
  progress(peerId: string, id: string): number | null {
    const p = this.pending.get(Reassembler.key(peerId, id));
    if (!p) return null;
    return p.parts.size / p.meta.chunks;
  }

  /** Drop expired transfers. Returns their metadata so the UI can say so. */
  sweep(now: number = Date.now()): FileMeta[] {
    const dropped: FileMeta[] = [];
    for (const [key, p] of this.pending) {
      if (now - p.started > REASSEMBLY_TTL_MS) {
        dropped.push(p.meta);
        this.pending.delete(key);
      }
    }
    return dropped;
  }

  clear(): void {
    this.pending.clear();
  }

  get inFlight(): number {
    return this.pending.size;
  }
}

/** The bit of RTCDataChannel that {@link DataChannelWriter} needs. */
export interface DataChannelLike {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string): void;
  onbufferedamountlow: ((ev: Event) => void) | null;
}

/**
 * Serialises sends and respects backpressure: above {@link BUFFER_HIGH} buffered
 * bytes it waits for `bufferedamountlow` (threshold {@link BUFFER_LOW}) instead of
 * blindly queueing, which is what stops a 5 MB image from stalling voice on a
 * mid-range phone.
 */
export class DataChannelWriter {
  private queue: string[] = [];
  private draining = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly dc: DataChannelLike) {
    this.dc.bufferedAmountLowThreshold = BUFFER_LOW;
    this.dc.onbufferedamountlow = () => {
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    };
  }

  /** Queue a wire string. Resolves when it has been handed to the channel. */
  async send(wire: string): Promise<void> {
    this.queue.push(wire);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        if (this.dc.readyState !== 'open') {
          this.queue.length = 0;
          return;
        }
        if (this.dc.bufferedAmount > BUFFER_HIGH) {
          await new Promise<void>((resolve) => {
            this.waiters.push(resolve);
            // Safety net: some implementations do not fire the event if the
            // threshold was already crossed when we subscribed.
            setTimeout(resolve, 250);
          });
          continue;
        }
        const next = this.queue.shift();
        if (next === undefined) return;
        this.dc.send(next);
      }
    } finally {
      this.draining = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  close(): void {
    this.queue.length = 0;
    this.dc.onbufferedamountlow = null;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }
}
