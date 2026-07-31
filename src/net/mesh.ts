/**
 * Full-mesh RTCPeerConnection manager.
 *
 * Every peer connects to every other peer: n(n-1)/2 connections, which is why the
 * UI caps the channel at 8 people. Beyond that a phone spends its battery on
 * encoders, not on audio.
 *
 * Two identifiers, deliberately kept apart:
 *  - `connId`  - assigned by the relay, routing only, changes on reconnect.
 *  - `peerId`  - SHA-256 of a per-session public key, inside the sealed envelope.
 *                Decides the polite/impolite role and is what the UI trusts.
 *
 * Media is DTLS-SRTP as usual. What makes a hostile relay harmless is that every
 * SDP and ICE candidate is sealed with the channel key, so the relay cannot swap in
 * its own DTLS fingerprint (see THREAT-MODEL.md).
 */

import { open, seal } from '../crypto/aead';
import { safetyWords } from '../crypto/fingerprint';
import { ReplayGuard, makeEnvelope, verifyEnvelope, type Identity } from '../crypto/identity';
import { attachPeerAudio, detachPeerAudio } from '../audio/playback';
import { debugLog, notify, state } from '../state';
import { isFrame, type Frame, type Peer, type Signal } from '../types';
import { DataChannelWriter, Reassembler, type Completed, type FileMeta } from './datachannel';
import { Negotiator, isPolite } from './perfect-negotiation';
import type { SignalingClient } from './signaling';

/** Hard UI cap. The relay allows 12; a mesh of 8 is already 28 connections. */
export const MAX_MESH_PEERS = 8;

const DATA_CHANNEL_LABEL = 'cw';
const STATS_INTERVAL_MS = 3_000;
const REBUILD_DELAY_MS = 3_000;
/** Opus target for speech. 24 kbps mono is plenty and survives campus wifi. */
const AUDIO_MAX_BITRATE = 24_000;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const turnUrl = import.meta.env['VITE_TURN_URL'];
  if (typeof turnUrl === 'string' && turnUrl.length > 0) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env['VITE_TURN_USER'] ?? '',
      credential: import.meta.env['VITE_TURN_PASS'] ?? '',
    });
  }
  return servers;
}

interface Runtime {
  peer: Peer;
  pc: RTCPeerConnection;
  negotiator: Negotiator;
  dc: RTCDataChannel | null;
  writer: DataChannelWriter | null;
  restarted: boolean;
  rebuildTimer: ReturnType<typeof setTimeout> | null;
}

export interface MeshHandlers {
  /** A verified frame from `peerId`. `relayed` is true when it came via the relay. */
  onFrame(peerId: string, frame: Frame, relayed: boolean): void;
  /** A file/voice payload finished reassembling. */
  onPayload(peerId: string, payload: Completed, relayed: boolean): void;
  /** A transfer timed out. */
  onPayloadTimeout(peerId: string, meta: FileMeta): void;
}

export class Mesh {
  private runtimes = new Map<string, Runtime>();
  private dcGuard = new ReplayGuard();
  private reassembler = new Reassembler();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private localTrack: MediaStreamTrack | null = null;

  constructor(
    private readonly identity: Identity,
    private readonly channelId: string,
    private readonly key: CryptoKey,
    private readonly signaling: SignalingClient,
    private readonly handlers: MeshHandlers,
  ) {
    this.statsTimer = setInterval(() => void this.pollStats(), STATS_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), 10_000);
  }

  /* ------------------------------------------------------------ local media */

  /**
   * Give the mesh the (muted) microphone track. Adding it once at join time and
   * gating with `track.enabled` is what makes PTT instant: no renegotiation on press.
   */
  setLocalTrack(track: MediaStreamTrack | null): void {
    this.localTrack = track;
    if (!track) return;
    for (const rt of this.runtimes.values()) this.addLocalTrack(rt);
  }

  private addLocalTrack(rt: Runtime): void {
    if (!this.localTrack) return;
    const already = rt.pc.getSenders().some((s) => s.track === this.localTrack);
    if (already) return;
    const sender = rt.pc.addTrack(this.localTrack, new MediaStream([this.localTrack]));
    void this.tuneSender(sender);
  }

  /**
   * Opus tuning. The spec allows SDP munging or `setParameters`; we use
   * `setParameters` because munging the SDP fights the perfect-negotiation pattern
   * (which relies on the argument-less `setLocalDescription`). `dtx` is set only
   * where the browser exposes it - it is not in every implementation.
   */
  private async tuneSender(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = params.encodings[0] as RTCRtpEncodingParameters & { dtx?: string };
      enc.maxBitrate = AUDIO_MAX_BITRATE;
      enc.networkPriority = 'high';
      enc.priority = 'high';
      if ('dtx' in enc) enc.dtx = 'enabled';
      await sender.setParameters(params);
    } catch (err) {
      debugLog('sender-params', err);
    }
  }

  /* ----------------------------------------------------------- relay events */

  /** Relay welcome: announce ourselves to everyone already in the room. */
  onWelcome(peers: string[]): void {
    // Reconnect safety: forget connIds that are no longer in the room, keep the
    // ones that are, so we never build a second pc for a peer we already have.
    for (const connId of [...this.runtimes.keys()]) {
      if (!peers.includes(connId)) this.removePeer(connId, 'gone after reconnect');
    }
    void this.hello(null);
  }

  onJoin(connId: string): void {
    if (this.runtimes.size >= MAX_MESH_PEERS) {
      debugLog('mesh-full', connId);
      return;
    }
    void this.hello(connId);
  }

  onLeave(connId: string): void {
    this.removePeer(connId, 'left');
  }

  private async hello(to: string | null): Promise<void> {
    await this.signaling.send(to, {
      k: 'hello',
      name: state.name,
      pub: this.identity.pub,
    });
  }

  /** A verified, decrypted signal arrived over the relay. */
  async onSignal(connId: string, peerId: string, pub: string, signal: Signal): Promise<void> {
    if (peerId === this.identity.peerId) return; // our own broadcast echo
    const rt = await this.ensurePeer(connId, peerId, pub);
    if (!rt) return;

    switch (signal.k) {
      case 'sdp':
        await rt.negotiator.handleDescription(signal.sdp);
        return;
      case 'ice':
        await rt.negotiator.handleCandidate(signal.c);
        return;
      case 'hello':
        if (signal.name && signal.name !== rt.peer.name) {
          rt.peer.name = signal.name.slice(0, 24);
          notify();
        }
        // Answer a targeted hello so the other side learns our name too.
        if (rt.peer.impolite) void this.hello(connId);
        return;
      default:
        // Any other frame over the relay is the fallback transport (voice notes,
        // text while the data channel is down).
        this.handleFrame(rt.peer, signal, true);
    }
  }

  /* ------------------------------------------------------- peer lifecycle */

  private async ensurePeer(connId: string, peerId: string, pub: string): Promise<Runtime | null> {
    const existing = this.runtimes.get(connId);
    if (existing) {
      if (existing.peer.peerId !== peerId) {
        // The relay reused a connId for a different identity: rebuild.
        this.removePeer(connId, 'identity changed');
      } else {
        return existing;
      }
    }
    if (this.runtimes.size >= MAX_MESH_PEERS) {
      state.link = 'full';
      notify();
      return null;
    }

    const impolite = !isPolite(this.identity.peerId, peerId);
    const peer: Peer = {
      connId,
      peerId,
      pub,
      name: 'someone',
      state: 'connecting',
      impolite,
      talking: false,
      verified: false,
      transport: 'relayed',
      quality: { rttMs: null, loss: null, jitterMs: null },
      safetyWords: await safetyWords(this.identity.pub, pub),
    };

    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    const negotiator = new Negotiator(pc, !impolite, {
      sendDescription: (sdp) => void this.signaling.send(connId, { k: 'sdp', sdp }),
      sendCandidate: (c) => void this.signaling.send(connId, { k: 'ice', c }),
      onError: (where, err) => debugLog(`negotiation:${where}`, err),
    });

    const rt: Runtime = { peer, pc, negotiator, dc: null, writer: null, restarted: false, rebuildTimer: null };
    this.runtimes.set(connId, rt);
    state.peers.set(connId, peer);

    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (stream) attachPeerAudio(peerId, stream);
    };
    pc.onconnectionstatechange = () => this.onConnectionState(rt);
    pc.ondatachannel = (ev) => this.bindDataChannel(rt, ev.channel);

    this.addLocalTrack(rt);
    // Only the impolite peer creates the channel, so we never end up with two.
    if (impolite) this.bindDataChannel(rt, pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));

    notify();
    return rt;
  }

  private onConnectionState(rt: Runtime): void {
    const cs = rt.pc.connectionState;
    debugLog('pc-state', `${rt.peer.peerId.slice(0, 6)} ${cs}`);
    if (cs === 'connected') {
      rt.peer.state = rt.dc?.readyState === 'open' ? 'connected' : 'connecting';
      rt.restarted = false;
    } else if (cs === 'failed') {
      rt.peer.state = 'failed';
      rt.peer.transport = 'relayed';
      if (!rt.restarted) {
        rt.restarted = true;
        try {
          rt.pc.restartIce();
        } catch (err) {
          debugLog('restart-ice', err);
        }
      } else if (rt.rebuildTimer === null) {
        // One ICE restart, then a clean rebuild. Never leak the dead connection.
        rt.rebuildTimer = setTimeout(() => void this.rebuild(rt), REBUILD_DELAY_MS);
      }
    } else if (cs === 'closed' || cs === 'disconnected') {
      rt.peer.state = cs === 'closed' ? 'closed' : 'failed';
    }
    notify();
  }

  private async rebuild(rt: Runtime): Promise<void> {
    const { connId, peerId, pub } = rt.peer;
    this.removePeer(connId, 'rebuild');
    if (!this.signaling.isOpen()) return;
    await this.ensurePeer(connId, peerId, pub);
    await this.hello(connId);
  }

  private bindDataChannel(rt: Runtime, dc: RTCDataChannel): void {
    rt.dc = dc;
    rt.writer = new DataChannelWriter(dc);
    dc.onopen = () => {
      rt.peer.state = 'connected';
      rt.peer.transport = 'direct';
      notify();
      void this.sendFrame(rt.peer.connId, { k: 'hello', name: state.name, pub: this.identity.pub });
    };
    dc.onclose = () => {
      rt.peer.transport = 'relayed';
      if (rt.peer.state === 'connected') rt.peer.state = 'connecting';
      notify();
    };
    dc.onerror = (ev) => debugLog('dc-error', (ev as RTCErrorEvent).error?.message ?? 'error');
    dc.onmessage = (ev) => void this.onDataChannelMessage(rt, ev);
  }

  private async onDataChannelMessage(rt: Runtime, ev: MessageEvent): Promise<void> {
    if (typeof ev.data !== 'string') return;
    let envelope: unknown;
    try {
      envelope = await open(this.key, this.channelId, ev.data);
    } catch {
      debugLog('dc-undecryptable', rt.peer.peerId.slice(0, 6));
      return;
    }
    const result = await verifyEnvelope<Signal>(this.channelId, envelope, this.dcGuard);
    if (!result.ok || !result.env) {
      debugLog('dc-envelope-rejected', `${rt.peer.peerId.slice(0, 6)} ${result.reason}`);
      return;
    }
    // A peer may only speak for itself: no forwarding other people's identities.
    if (result.env.from !== rt.peer.peerId) {
      debugLog('dc-wrong-sender', rt.peer.peerId.slice(0, 6));
      return;
    }
    if (!isFrame(result.env.body)) return;
    this.handleFrame(rt.peer, result.env.body, false);
  }

  private handleFrame(peer: Peer, frame: Frame, relayed: boolean): void {
    switch (frame.k) {
      case 'hello':
        if (frame.name) peer.name = frame.name.slice(0, 24);
        notify();
        return;
      case 'ptt':
        peer.talking = frame.on;
        state.talker = frame.on ? peer.peerId : state.talker === peer.peerId ? '' : state.talker;
        notify();
        return;
      case 'file':
        if (!this.reassembler.begin(peer.peerId, frame)) {
          debugLog('bad-file-meta', frame.id);
          return;
        }
        this.handlers.onFrame(peer.peerId, frame, relayed);
        return;
      case 'chunk': {
        const done = this.reassembler.push(peer.peerId, frame);
        this.handlers.onFrame(peer.peerId, frame, relayed);
        if (done) this.handlers.onPayload(peer.peerId, done, relayed);
        return;
      }
      case 'bye':
        peer.state = 'closed';
        notify();
        return;
      default:
        this.handlers.onFrame(peer.peerId, frame, relayed);
    }
  }

  /* ------------------------------------------------------------- sending */

  /** Send one frame to one peer, preferring the data channel. */
  async sendFrame(connId: string, frame: Frame): Promise<void> {
    const rt = this.runtimes.get(connId);
    if (!rt) return;
    const envelope = await makeEnvelope(this.identity, this.channelId, frame);
    const wire = await seal(this.key, this.channelId, envelope);
    if (rt.writer && rt.dc?.readyState === 'open') {
      await rt.writer.send(wire);
    } else {
      // Fallback: same sealed bytes, different pipe.
      await this.signaling.send(connId, frame);
    }
  }

  /** Send one frame to every peer. */
  async broadcast(frame: Frame): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((connId) => this.sendFrame(connId, frame)));
  }

  /** True when at least one peer is reachable over a direct data channel. */
  get anyDirect(): boolean {
    for (const rt of this.runtimes.values()) if (rt.dc?.readyState === 'open') return true;
    return false;
  }

  get size(): number {
    return this.runtimes.size;
  }

  peerByPeerId(peerId: string): Peer | undefined {
    for (const rt of this.runtimes.values()) if (rt.peer.peerId === peerId) return rt.peer;
    return undefined;
  }

  /* --------------------------------------------------------------- stats */

  private async pollStats(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      if (rt.pc.connectionState !== 'connected') continue;
      try {
        const report = await rt.pc.getStats();
        let rtt: number | null = null;
        let loss: number | null = null;
        let jitter: number | null = null;
        report.forEach((s) => {
          const stat = s as Record<string, unknown>;
          if (stat['type'] === 'candidate-pair' && stat['state'] === 'succeeded') {
            const t = stat['currentRoundTripTime'];
            if (typeof t === 'number') rtt = Math.round(t * 1000);
          }
          if (stat['type'] === 'inbound-rtp' && stat['kind'] === 'audio') {
            const lost = Number(stat['packetsLost'] ?? 0);
            const recv = Number(stat['packetsReceived'] ?? 0);
            if (recv + lost > 0) loss = lost / (recv + lost);
            const j = stat['jitter'];
            if (typeof j === 'number') jitter = Math.round(j * 1000);
          }
        });
        rt.peer.quality = { rttMs: rtt, loss, jitterMs: jitter };
      } catch (err) {
        debugLog('getStats', err);
      }
    }
    notify();
  }

  private sweep(): void {
    for (const meta of this.reassembler.sweep()) {
      this.handlers.onPayloadTimeout('', meta);
    }
  }

  /* ------------------------------------------------------------ teardown */

  private removePeer(connId: string, why: string): void {
    const rt = this.runtimes.get(connId);
    if (!rt) return;
    debugLog('peer-remove', `${connId} ${why}`);
    if (rt.rebuildTimer !== null) clearTimeout(rt.rebuildTimer);
    rt.writer?.close();
    try {
      rt.dc?.close();
    } catch {
      /* already closed */
    }
    rt.pc.ontrack = null;
    rt.pc.onconnectionstatechange = null;
    rt.pc.ondatachannel = null;
    rt.pc.onicecandidate = null;
    rt.pc.onnegotiationneeded = null;
    try {
      rt.pc.close();
    } catch {
      /* already closed */
    }
    detachPeerAudio(rt.peer.peerId);
    this.runtimes.delete(connId);
    state.peers.delete(connId);
    if (state.talker === rt.peer.peerId) state.talker = '';
    if (state.link === 'full' && this.runtimes.size < MAX_MESH_PEERS) state.link = 'connected';
    notify();
  }

  /** Say goodbye, close everything, leave nothing running. */
  async destroy(): Promise<void> {
    try {
      await this.broadcast({ k: 'bye' });
    } catch {
      /* best effort */
    }
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.statsTimer = null;
    this.sweepTimer = null;
    for (const connId of [...this.runtimes.keys()]) this.removePeer(connId, 'destroy');
    this.reassembler.clear();
    this.dcGuard.clear();
  }
}
