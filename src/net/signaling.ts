/**
 * Encrypted WebSocket & BroadcastChannel client for the signalling relay.
 *
 * Everything the app sends is `seal(makeEnvelope(body))`, so the frame the relay
 * handles is `{"t":"sig","to":...,"d":"<base64url ciphertext>"}` and `d` is the only
 * field carrying app data. Inbound envelopes are verified (signature, key
 * continuity, clock skew, monotonic seq) before the body is handed up; failures go
 * to the debug ring buffer and are otherwise ignored.
 *
 * Supports BroadcastChannel for 0-latency instant local tab/window signaling fallback.
 */

import { open, seal } from '../crypto/aead';
import { ReplayGuard, makeEnvelope, verifyEnvelope, type Identity } from '../crypto/identity';
import { debugLog, notify, state } from '../state';
import { isSignal, type Signal } from '../types';

export interface SignalingHandlers {
  /** Relay accepted us. `peers` are the connIds already in the room. */
  onWelcome(you: string, peers: string[]): void;
  onJoin(connId: string): void;
  onLeave(connId: string): void;
  /** A verified, decrypted signal from `connId`, sent by `peerId`. */
  onSignal(connId: string, peerId: string, pub: string, signal: Signal): void;
  onState(state: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'full'): void;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private bc: BroadcastChannel | null = null;
  private closedByUs = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private guard = new ReplayGuard();
  private localConnId = crypto.randomUUID().slice(0, 8);
  /** Our connId for the current session. */
  you = '';

  constructor(
    private readonly url: string,
    private readonly channelId: string,
    private readonly key: CryptoKey,
    private readonly identity: Identity,
    private readonly handlers: SignalingHandlers,
  ) {
    this.you = this.localConnId;
    this.initBroadcastChannel();
  }

  private initBroadcastChannel(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.bc = new BroadcastChannel(`cw_bc_${this.channelId}`);
      this.bc.onmessage = (ev: MessageEvent) => {
        if (this.closedByUs || !ev.data || typeof ev.data !== 'object') return;
        const msg = ev.data as { t?: string; from?: string; to?: string; d?: string; id?: string };
        if (msg.from === this.you) return;

        switch (msg.t) {
          case 'discover':
            // Another local tab joined: announce ourselves back and join them
            this.bc?.postMessage({ t: 'presence', from: this.you });
            if (msg.from) this.handlers.onJoin(msg.from);
            break;
          case 'presence':
            if (msg.from) this.handlers.onJoin(msg.from);
            break;
          case 'leave':
            if (msg.id) this.handlers.onLeave(msg.id);
            break;
          case 'sig':
            if ((!msg.to || msg.to === this.you) && msg.from && msg.d) {
              void this.onSealed(msg.from, msg.d);
            }
            break;
        }
      };
    } catch (err) {
      debugLog('bc-init-failed', err);
    }
  }

  /** Full ws:// or wss:// room URL for the current channel. */
  roomUrl(): string {
    const base = this.url.replace(/\/+$/, '').replace(/^http/, 'ws');
    return `${base}/room/${this.channelId}`;
  }

  connect(): void {
    this.closedByUs = false;
    this.clearRetry();
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // Announce local presence over BroadcastChannel
    this.bc?.postMessage({ t: 'discover', from: this.you });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.roomUrl());
    } catch (err) {
      debugLog('ws-open-failed', err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      state.reconnectSeconds = 0;
      this.clearRetry();
      this.handlers.onState('connected');
    };
    ws.onmessage = (ev) => void this.onMessage(ev);
    ws.onerror = () => {
      debugLog('ws-error', this.roomUrl());
      if (this.ws === ws) this.handlers.onState('reconnecting');
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs) return;
      if (ev.code === 1013) {
        this.handlers.onState('full');
        return;
      }
      debugLog('ws-close', `${ev.code} ${ev.reason}`);
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    this.attempt++;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.attempt - 1));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    let remaining = Math.max(1, Math.ceil(delay / 1000));
    state.reconnectSeconds = remaining;
    
    this.handlers.onState('reconnecting');

    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.countdownInterval = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      state.reconnectSeconds = remaining;
      notify();
      if (remaining <= 0 && this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
      }
    }, 1000);

    debugLog('ws-retry', `attempt ${this.attempt} in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.clearRetry();
      this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private async onMessage(ev: MessageEvent): Promise<void> {
    if (typeof ev.data !== 'string') return;
    let msg: { t?: unknown; you?: unknown; peers?: unknown; id?: unknown; from?: unknown; d?: unknown };
    try {
      msg = JSON.parse(ev.data) as typeof msg;
    } catch {
      debugLog('ws-bad-json', ev.data.slice(0, 40));
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        if (typeof msg.you !== 'string' || !Array.isArray(msg.peers)) return;
        this.you = msg.you;
        this.handlers.onWelcome(
          msg.you,
          msg.peers.filter((p): p is string => typeof p === 'string'),
        );
        return;
      }
      case 'join':
        if (typeof msg.id === 'string') this.handlers.onJoin(msg.id);
        return;
      case 'leave':
        if (typeof msg.id === 'string') this.handlers.onLeave(msg.id);
        return;
      case 'ping':
        this.raw({ t: 'pong' });
        return;
      case 'full':
        this.handlers.onState('full');
        return;
      case 'sig': {
        if (typeof msg.from !== 'string' || typeof msg.d !== 'string') return;
        await this.onSealed(msg.from, msg.d);
        return;
      }
      default:
        debugLog('ws-unknown', String(msg.t));
    }
  }

  private async onSealed(connId: string, wire: string): Promise<void> {
    let envelope: unknown;
    try {
      envelope = await open(this.key, this.channelId, wire);
    } catch {
      debugLog('undecryptable', connId);
      return;
    }
    const result = await verifyEnvelope<Signal>(this.channelId, envelope, this.guard);
    if (!result.ok || !result.env) {
      debugLog('envelope-rejected', `${connId} ${result.reason}`);
      return;
    }
    const env = result.env;
    if (!isSignal(env.body)) {
      debugLog('bad-signal-body', connId);
      return;
    }
    this.handlers.onSignal(connId, env.from, env.pub, env.body);
  }

  /** Seal `body` in a signed envelope and send it. `to = null` broadcasts. */
  async send(to: string | null, body: Signal): Promise<void> {
    const envelope = await makeEnvelope(this.identity, this.channelId, body);
    const d = await seal(this.key, this.channelId, envelope);
    
    // 1. Post to local BroadcastChannel for zero-latency local tab mesh
    try {
      this.bc?.postMessage({ t: 'sig', from: this.you, to, d });
    } catch (err) {
      debugLog('bc-send-failed', err);
    }

    // 2. Post to WebSocket relay if connected
    if (this.isOpen()) {
      this.raw({ t: 'sig', to, d });
    }
  }

  private raw(obj: unknown): void {
    if (!this.isOpen()) return;
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch (err) {
      debugLog('ws-send-failed', err);
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closedByUs = true;
    this.clearRetry();
    this.guard.clear();
    try {
      this.bc?.postMessage({ t: 'leave', id: this.you });
      this.bc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.bc = null;
    this.you = '';
  }
}
