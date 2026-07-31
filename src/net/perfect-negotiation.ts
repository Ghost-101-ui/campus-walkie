/**
 * Perfect negotiation (WebRTC 1.0 §4.4.4, and the MDN "Perfect negotiation"
 * guide). It is the only sane way to run a mesh where either side may need to
 * renegotiate at any moment, and glare - both sides offering at once - is the
 * single biggest source of "it works on my laptop" WebRTC bugs.
 *
 * Roles: the lexicographically smaller peerId is **polite**. The polite peer
 * yields on collision and rolls back its own offer; the impolite peer ignores the
 * incoming offer and keeps its own. Roles are derived from ids both sides already
 * know, so there is no role handshake to get wrong.
 *
 * This module is deliberately transport-agnostic and only touches the small
 * RTCPeerConnection surface declared in `PeerConnectionLike`, so the glare case can
 * be unit-tested against a mock.
 */

export interface PeerConnectionLike {
  signalingState: RTCSignalingState;
  localDescription: RTCSessionDescription | RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescription | RTCSessionDescriptionInit | null;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>;
  restartIce?(): void;
  onnegotiationneeded: ((this: RTCPeerConnection, ev: Event) => void) | null;
  onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => void) | null;
  oniceconnectionstatechange?: ((this: RTCPeerConnection, ev: Event) => void) | null;
  iceConnectionState?: RTCIceConnectionState;
}

export interface NegotiationTransport {
  sendDescription(description: RTCSessionDescriptionInit): void;
  sendCandidate(candidate: RTCIceCandidateInit): void;
  /** Non-fatal problems: logged, never thrown at the caller. */
  onError?(where: string, err: unknown): void;
}

/** True if `self` should take the polite role against `other`. */
export function isPolite(selfPeerId: string, otherPeerId: string): boolean {
  return selfPeerId < otherPeerId;
}

export class Negotiator {
  private makingOffer = false;
  private ignoreOffer = false;
  /** Buffer candidates that arrive before the first remote description. */
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    private readonly pc: PeerConnectionLike,
    private readonly polite: boolean,
    private readonly transport: NegotiationTransport,
  ) {
    this.pc.onnegotiationneeded = () => void this.onNegotiationNeeded();
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.transport.sendCandidate(candidate.toJSON());
    };
    if ('oniceconnectionstatechange' in this.pc) {
      this.pc.oniceconnectionstatechange = () => {
        if (this.pc.iceConnectionState === 'failed') this.pc.restartIce?.();
      };
    }
  }

  private async onNegotiationNeeded(): Promise<void> {
    try {
      this.makingOffer = true;
      // Argument-less setLocalDescription: the browser picks offer vs answer and
      // guarantees it is the right one for the current signalling state.
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) this.transport.sendDescription(this.pc.localDescription);
    } catch (err) {
      this.transport.onError?.('negotiationneeded', err);
    } finally {
      this.makingOffer = false;
    }
  }

  /** Handle an inbound offer or answer. Never throws. */
  async handleDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const offerCollision =
      description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      if (offerCollision) {
        // Modern browsers roll back implicitly inside setRemoteDescription. Safari
        // has historically needed the explicit rollback, so try implicit and fall
        // back rather than assuming either behaviour.
        try {
          await this.pc.setRemoteDescription(description);
        } catch {
          await this.pc.setLocalDescription({ type: 'rollback' });
          await this.pc.setRemoteDescription(description);
        }
      } else {
        await this.pc.setRemoteDescription(description);
      }
      await this.flushCandidates();
      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) this.transport.sendDescription(this.pc.localDescription);
      }
    } catch (err) {
      this.transport.onError?.('handleDescription', err);
    }
  }

  /** Handle an inbound ICE candidate. Never throws. */
  async handleCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // Expected while an ignored offer is in flight: the candidate belongs to a
      // description we deliberately discarded.
      if (!this.ignoreOffer) this.transport.onError?.('addIceCandidate', err);
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (err) {
        if (!this.ignoreOffer) this.transport.onError?.('flushCandidates', err);
      }
    }
  }

  /** For tests and diagnostics. */
  get busy(): boolean {
    return this.makingOffer;
  }
}
