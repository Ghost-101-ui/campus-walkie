import { describe, expect, it, vi } from 'vitest';
import {
  BUFFER_HIGH,
  DataChannelWriter,
  MAX_CHUNK_CHARS,
  RAW_CHUNK_BYTES,
  REASSEMBLY_TTL_MS,
  Reassembler,
  chunkCount,
  fileFrame,
  splitPayload,
  type DataChannelLike,
} from './datachannel';
import { Negotiator, isPolite, type PeerConnectionLike } from './perfect-negotiation';
import type { Frame } from '../types';

/* --------------------------------------------------------------- chunking */

function chunkFrames(frames: Frame[]): Extract<Frame, { k: 'chunk' }>[] {
  return frames.filter((f): f is Extract<Frame, { k: 'chunk' }> => f.k === 'chunk');
}

describe('chunker', () => {
  it('keeps every encoded chunk within 12 KB', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(RAW_CHUNK_BYTES * 3 + 17));
    for (const f of chunkFrames(splitPayload('t1', bytes))) {
      expect(f.d.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('splits and reassembles a 3 MB payload', () => {
    const size = 3 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i & 0xff;

    const meta = fileFrame('t2', 'photo.jpg', 'image/jpeg', size);
    expect(meta.k).toBe('file');
    if (meta.k !== 'file') throw new Error('unreachable');
    expect(meta.chunks).toBe(chunkCount(size));

    const r = new Reassembler();
    expect(r.begin('peerA', meta)).toBe(true);
    const frames = chunkFrames(splitPayload('t2', bytes));
    expect(frames).toHaveLength(meta.chunks);

    let done = null;
    for (const f of frames) done = r.push('peerA', f) ?? done;
    expect(done).not.toBeNull();
    expect(done?.bytes.length).toBe(size);
    expect(done?.bytes[0]).toBe(0);
    expect(done?.bytes[size - 1]).toBe((size - 1) & 0xff);
    expect(r.inFlight).toBe(0);
  });

  it('reassembles out-of-order arrival', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(RAW_CHUNK_BYTES * 5 + 3));
    const meta = fileFrame('t3', 'a.bin', 'application/octet-stream', bytes.length);
    if (meta.k !== 'file') throw new Error('unreachable');
    const r = new Reassembler();
    r.begin('peerA', meta);

    const frames = chunkFrames(splitPayload('t3', bytes)).reverse();
    let done = null;
    for (const f of frames) done = r.push('peerA', f) ?? done;
    expect(done?.bytes).toEqual(bytes);
  });

  it('ignores duplicate and out-of-range chunks', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(RAW_CHUNK_BYTES * 2));
    const meta = fileFrame('t4', 'a.bin', 'x', bytes.length);
    if (meta.k !== 'file') throw new Error('unreachable');
    const r = new Reassembler();
    r.begin('peerA', meta);
    const frames = chunkFrames(splitPayload('t4', bytes));
    const first = frames[0];
    if (!first) throw new Error('no frames');
    expect(r.push('peerA', first)).toBeNull();
    expect(r.push('peerA', first)).toBeNull(); // duplicate
    expect(r.push('peerA', { k: 'chunk', id: 't4', i: 99, d: 'AAAA' })).toBeNull();
    expect(r.progress('peerA', 't4')).toBeCloseTo(0.5);
  });

  it('keeps transfers from different peers apart', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(100));
    const meta = fileFrame('same-id', 'a.bin', 'x', bytes.length);
    if (meta.k !== 'file') throw new Error('unreachable');
    const r = new Reassembler();
    r.begin('peerA', meta);
    r.begin('peerB', meta);
    const [frame] = chunkFrames(splitPayload('same-id', bytes));
    if (!frame) throw new Error('no frame');
    expect(r.push('peerA', frame)?.bytes).toEqual(bytes);
    expect(r.inFlight).toBe(1); // peerB's is still waiting
  });

  it('drops a transfer with a missing chunk after the TTL', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(RAW_CHUNK_BYTES * 3));
    const meta = fileFrame('t5', 'a.bin', 'x', bytes.length);
    if (meta.k !== 'file') throw new Error('unreachable');
    const r = new Reassembler();
    const t0 = 1_000_000;
    r.begin('peerA', meta, t0);
    const frames = chunkFrames(splitPayload('t5', bytes));
    const first = frames[0];
    const second = frames[1];
    if (!first || !second) throw new Error('no frames');
    r.push('peerA', first);
    r.push('peerA', second); // third never arrives

    expect(r.sweep(t0 + REASSEMBLY_TTL_MS - 1)).toEqual([]);
    expect(r.inFlight).toBe(1);
    const dropped = r.sweep(t0 + REASSEMBLY_TTL_MS + 1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.id).toBe('t5');
    expect(r.inFlight).toBe(0);
  });

  it('rejects metadata that lies about the chunk count', () => {
    const r = new Reassembler();
    expect(r.begin('peerA', { id: 'x', name: 'a', mime: 'x', size: 1000, chunks: 99 })).toBe(false);
  });

  it('drops a transfer that sends more bytes than it declared', () => {
    const r = new Reassembler();
    const meta = { id: 'x', name: 'a', mime: 'x', size: 10, chunks: 1 };
    expect(r.begin('peerA', meta)).toBe(true);
    const big = crypto.getRandomValues(new Uint8Array(500));
    const [frame] = chunkFrames(splitPayload('x', big));
    if (!frame) throw new Error('no frame');
    expect(r.push('peerA', frame)).toBeNull();
    expect(r.inFlight).toBe(0);
  });
});

/* ------------------------------------------------------------ backpressure */

class FakeDataChannel implements DataChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
    this.bufferedAmount += data.length;
  }
  drain(): void {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.(new Event('bufferedamountlow'));
  }
}

describe('DataChannelWriter', () => {
  it('sends in order and stops sending above the high-water mark', async () => {
    const dc = new FakeDataChannel();
    const w = new DataChannelWriter(dc);
    expect(dc.bufferedAmountLowThreshold).toBeGreaterThan(0);

    await w.send('a');
    await w.send('b');
    expect(dc.sent).toEqual(['a', 'b']);

    dc.bufferedAmount = BUFFER_HIGH + 1;
    const blocked = w.send('c');
    await Promise.resolve();
    expect(dc.sent).toEqual(['a', 'b']);

    dc.drain();
    await blocked;
    expect(dc.sent).toEqual(['a', 'b', 'c']);
  });

  it('drops the queue when the channel closes', async () => {
    const dc = new FakeDataChannel();
    const w = new DataChannelWriter(dc);
    dc.readyState = 'closed';
    await w.send('x');
    expect(dc.sent).toEqual([]);
    w.close();
  });
});

/* ------------------------------------------------- perfect negotiation glare */

/**
 * Minimal RTCPeerConnection stand-in with real signalling-state rules, so the
 * glare case is tested against the state machine rather than against a spy.
 */
class MockPeerConnection implements PeerConnectionLike {
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onnegotiationneeded: ((this: unknown, ev: Event) => void) | null = null;
  onicecandidate: ((this: unknown, ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: ((this: unknown, ev: Event) => void) | null = null;
  iceConnectionState: RTCIceConnectionState = 'new';
  candidates: RTCIceCandidateInit[] = [];
  rollbacks = 0;
  restarts = 0;
  private n = 0;

  constructor(
    readonly label: string,
    /** Older Safari needed an explicit rollback; both paths are exercised. */
    private readonly implicitRollback = true,
  ) {}

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    if (description?.type === 'rollback') {
      this.rollbacks++;
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `${this.label}-${type}-${++this.n}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        if (!this.implicitRollback) throw new Error('InvalidStateError');
        this.rollbacks++;
        this.localDescription = null;
      }
      this.remoteDescription = description;
      this.signalingState = 'have-remote-offer';
      return;
    }
    if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError');
      this.remoteDescription = description;
      this.signalingState = 'stable';
      return;
    }
    throw new Error(`unexpected ${description.type}`);
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    if (candidate) this.candidates.push(candidate);
  }

  restartIce(): void {
    this.restarts++;
  }

  fireNegotiationNeeded(): void {
    this.onnegotiationneeded?.call(this, new Event('negotiationneeded'));
  }

  fireIceCandidate(c: RTCIceCandidateInit | null): void {
    this.onicecandidate?.call(this, {
      candidate: c ? ({ toJSON: () => c } as unknown as RTCIceCandidate) : null,
    });
  }
}

/** Cross-wires two negotiators through an explicit task queue. */
function link(implicitRollback = true) {
  const POLITE_ID = 'aaaa-polite';
  const IMPOLITE_ID = 'zzzz-impolite';
  expect(isPolite(POLITE_ID, IMPOLITE_ID)).toBe(true);
  expect(isPolite(IMPOLITE_ID, POLITE_ID)).toBe(false);

  const queue: Array<() => Promise<void>> = [];
  const pcA = new MockPeerConnection('A', implicitRollback);
  const pcB = new MockPeerConnection('B', implicitRollback);
  const errors: Array<[string, unknown]> = [];

  const negA = new Negotiator(pcA, true, {
    sendDescription: (d) => queue.push(() => negB.handleDescription(d)),
    sendCandidate: (c) => queue.push(() => negB.handleCandidate(c)),
    onError: (w, e) => errors.push([`A:${w}`, e]),
  });
  const negB = new Negotiator(pcB, false, {
    sendDescription: (d) => queue.push(() => negA.handleDescription(d)),
    sendCandidate: (c) => queue.push(() => negA.handleCandidate(c)),
    onError: (w, e) => errors.push([`B:${w}`, e]),
  });

  // Runs queued deliveries until nothing new appears. `onnegotiationneeded` handlers
  // are async, so an empty queue is not the same as "settled": wait out a few
  // macrotasks before giving up.
  const drain = async (): Promise<void> => {
    let idle = 0;
    for (let guard = 0; guard < 500; guard++) {
      const task = queue.shift();
      if (task) {
        idle = 0;
        await task();
        continue;
      }
      if (++idle > 3) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(queue).toHaveLength(0);
  };

  return { pcA, pcB, negA, negB, drain, errors };
}

describe('perfect negotiation', () => {
  it('assigns polite to the lexicographically smaller peer id', () => {
    expect(isPolite('abc', 'abd')).toBe(true);
    expect(isPolite('abd', 'abc')).toBe(false);
  });

  it('completes a plain one-sided negotiation', async () => {
    const { pcA, pcB, drain, errors } = link();
    pcB.fireNegotiationNeeded(); // impolite offers
    await drain();
    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
    expect(pcA.remoteDescription?.type).toBe('offer');
    expect(pcB.remoteDescription?.type).toBe('answer');
    expect(errors).toEqual([]);
  });

  it('resolves simultaneous offers without deadlock (polite rolls back)', async () => {
    const { pcA, pcB, drain, errors } = link();
    pcA.fireNegotiationNeeded();
    pcB.fireNegotiationNeeded();
    await drain();

    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
    // The impolite peer's offer survives: A applied B's offer and answered it.
    expect(pcA.remoteDescription?.sdp).toContain('B-offer');
    expect(pcB.remoteDescription?.type).toBe('answer');
    expect(pcA.rollbacks).toBe(1);
    expect(pcB.rollbacks).toBe(0);
    expect(errors).toEqual([]);
  });

  it('resolves glare on implementations without implicit rollback', async () => {
    const { pcA, pcB, drain, errors } = link(false);
    pcA.fireNegotiationNeeded();
    pcB.fireNegotiationNeeded();
    await drain();
    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
    expect(pcA.rollbacks).toBe(1);
    expect(errors).toEqual([]);
  });

  it('lets the impolite peer ignore a colliding offer', async () => {
    const { pcA, pcB, negB, drain } = link();
    pcA.fireNegotiationNeeded(); // A is mid-offer
    pcB.fireNegotiationNeeded();
    // Deliver A's offer to B while B is offering: B must ignore it.
    await negB.handleDescription({ type: 'offer', sdp: 'A-offer-x' });
    expect(pcB.remoteDescription?.sdp).not.toBe('A-offer-x');
    await drain();
    expect(pcA.signalingState).toBe('stable');
    expect(pcB.signalingState).toBe('stable');
  });

  it('buffers candidates that arrive before the remote description', async () => {
    const { pcA, pcB, negA, drain } = link();
    await negA.handleCandidate({ candidate: 'early', sdpMid: '0' });
    expect(pcA.candidates).toHaveLength(0);
    pcB.fireNegotiationNeeded();
    await drain();
    expect(pcA.candidates.map((c) => c.candidate)).toEqual(['early']);
  });

  it('forwards local candidates and ignores the end-of-candidates null', async () => {
    const { pcA, pcB, negB, drain } = link();
    pcB.fireNegotiationNeeded();
    await drain();
    pcA.fireIceCandidate({ candidate: 'host-1', sdpMid: '0' });
    pcA.fireIceCandidate(null);
    await drain();
    expect(pcB.candidates.map((c) => c.candidate)).toEqual(['host-1']);
    void negB;
  });

  it('restarts ICE when the connection fails', () => {
    const pc = new MockPeerConnection('A');
    new Negotiator(pc, true, { sendDescription: vi.fn(), sendCandidate: vi.fn() });
    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.call(pc, new Event('iceconnectionstatechange'));
    expect(pc.restarts).toBe(1);
  });
});
