/**
 * The whole application state, in one object, with a subscribe callback.
 * No store library: the UI is small enough that "mutate, then notify" is honest
 * and easy to follow.
 *
 * Nothing in here is written to disk except `name`, `channel` and `relay`, which
 * are put in localStorage by `ui/join.ts`. The passphrase, the derived keys and the
 * signing key never enter this object at all - they live in module scope in main.ts
 * and in non-extractable CryptoKeys.
 */

import type { DebugEntry, LinkState, Message, Peer } from './types';

export interface AppState {
  screen: 'join' | 'channel';
  link: LinkState;
  /** Normalised channel name, for display only. */
  channel: string;
  /** Our display name. */
  name: string;
  /** Our own cryptographic peer id. */
  peerId: string;
  /** Signing algorithm actually in use, for the Verify sheet. */
  sigAlg: string;
  peers: Map<string, Peer>;
  messages: Message[];
  /** peerId of whoever is currently transmitting, or '' for nobody. */
  talker: string;
  /** True while our own PTT is held. */
  transmitting: boolean;
  micState: 'off' | 'open' | 'denied' | 'busy' | 'unavailable';
  /** Half-duplex lockout: block PTT while someone else transmits. */
  halfDuplex: boolean;
  /** Sound was blocked by autoplay policy and needs one tap. */
  needsSoundTap: boolean;
  unread: number;
  /** A newer service worker is waiting. */
  updateReady: boolean;
  /** Reconnection countdown timer in seconds. */
  reconnectSeconds: number;
  debug: DebugEntry[];
}

const DEBUG_RING = 200;

export const state: AppState = {
  screen: 'join',
  link: 'idle',
  channel: '',
  name: '',
  peerId: '',
  sigAlg: '',
  peers: new Map(),
  messages: [],
  talker: '',
  transmitting: false,
  micState: 'off',
  halfDuplex: true,
  needsSoundTap: false,
  unread: 0,
  updateReady: false,
  reconnectSeconds: 0,
  debug: [],
};

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to every state change. Returns an unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queued = false;

/**
 * Tell the UI something changed. Coalesced to one render per animation frame so a
 * burst of ICE candidates or chunks cannot cause a hundred re-renders.
 */
export function notify(): void {
  if (queued) return;
  queued = true;
  const flush = () => {
    queued = false;
    for (const fn of listeners) fn();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/**
 * In-app debug ring buffer. Rejected envelopes, ICE failures and decrypt errors
 * land here instead of the console: in production the console is a leak surface
 * and a support nightmare. Open it from the menu.
 */
export function debugLog(tag: string, detail: unknown): void {
  const entry: DebugEntry = {
    ts: Date.now(),
    tag,
    detail: typeof detail === 'string' ? detail : safeStringify(detail),
  };
  state.debug.push(entry);
  if (state.debug.length > DEBUG_RING) state.debug.shift();
  if (import.meta.env.DEV) console.debug('[cw]', tag, entry.detail);
}

function safeStringify(x: unknown): string {
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

export function addMessage(m: Message): void {
  state.messages.push(m);
  if (state.messages.length > 500) state.messages.shift();
  notify();
}

export function findMessage(id: string): Message | undefined {
  return state.messages.find((m) => m.id === id);
}

export function systemMessage(body: string): void {
  addMessage({
    id: crypto.randomUUID(),
    kind: 'system',
    from: '',
    fromName: '',
    mine: false,
    ts: Date.now(),
    body,
    relayed: false,
  });
}

/** Wipe everything, including blob URLs. Used by panic and by leaving a channel. */
export function resetState(): void {
  for (const m of state.messages) if (m.url) URL.revokeObjectURL(m.url);
  state.peers.clear();
  state.messages.length = 0;
  state.debug.length = 0;
  state.screen = 'join';
  state.link = 'idle';
  state.channel = '';
  state.peerId = '';
  state.sigAlg = '';
  state.talker = '';
  state.transmitting = false;
  state.micState = 'off';
  state.needsSoundTap = false;
  state.unread = 0;
  notify();
}
