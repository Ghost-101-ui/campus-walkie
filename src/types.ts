/** Shared types. No runtime code here except the two type guards at the bottom. */

/* ------------------------------------------------------------------ frames */

/** Application payloads. Sealed with the channel key on both transports. */
export type Frame =
  | { k: 'hello'; name: string; pub: string }
  | { k: 'text'; id: string; body: string }
  | { k: 'ptt'; on: boolean }
  | { k: 'file'; id: string; name: string; mime: string; size: number; chunks: number }
  | { k: 'chunk'; id: string; i: number; d: string }
  | { k: 'ack'; id: string }
  | { k: 'bye' };

/** Signalling payloads. Only ever travel over the relay, always sealed. */
export type Signal =
  | { k: 'sdp'; sdp: RTCSessionDescriptionInit }
  | { k: 'ice'; c: RTCIceCandidateInit }
  | Frame;

/* ------------------------------------------------------------------- state */

export type LinkState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'full'
  | 'offline';

export type PeerState = 'new' | 'connecting' | 'connected' | 'relayed' | 'failed' | 'closed';

export interface PeerQuality {
  /** Round-trip time in ms from getStats(), or null before the first sample. */
  rttMs: number | null;
  /** Fraction 0-1 of inbound audio packets lost. */
  loss: number | null;
  /** Inbound jitter in ms. */
  jitterMs: number | null;
}

export interface Peer {
  /** Relay-assigned connection id. Routing only. */
  connId: string;
  /** Cryptographic peer id, from the sealed envelope. Empty until first hello. */
  peerId: string;
  /** base64url SPKI public key, empty until first hello. */
  pub: string;
  name: string;
  state: PeerState;
  /** True when this side is the impolite peer (creates the offer + data channel). */
  impolite: boolean;
  talking: boolean;
  /** Human-verified out of band. Memory only, never persisted. */
  verified: boolean;
  /** 'direct' once a data channel is open, 'relayed' when we fell back. */
  transport: 'direct' | 'relayed';
  quality: PeerQuality;
  safetyWords: string[];
}

export type MessageKind = 'text' | 'file' | 'voice' | 'system';

export interface Message {
  id: string;
  kind: MessageKind;
  /** '' for system messages, our own peerId for our messages. */
  from: string;
  fromName: string;
  mine: boolean;
  ts: number;
  /** Text body, or the file name for file/voice messages. */
  body: string;
  /** True when it arrived over the relay instead of a direct peer connection. */
  relayed: boolean;
  /** Blob URL for file/voice messages. Revoked on panic and on channel leave. */
  url?: string;
  mime?: string;
  size?: number;
  /** 0-1 while a transfer is in flight, undefined when complete. */
  progress?: number;
}

export interface DebugEntry {
  ts: number;
  tag: string;
  detail: string;
}

/* ------------------------------------------------------------------ guards */

export function isFrame(x: unknown): x is Frame {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { k?: unknown }).k;
  return (
    k === 'hello' ||
    k === 'text' ||
    k === 'ptt' ||
    k === 'file' ||
    k === 'chunk' ||
    k === 'ack' ||
    k === 'bye'
  );
}

export function isSignal(x: unknown): x is Signal {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { k?: unknown }).k;
  return k === 'sdp' || k === 'ice' || isFrame(x);
}
