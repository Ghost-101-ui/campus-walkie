/**
 * Per-peer playback. One `<audio autoplay playsinline>` element per peer, kept out
 * of the layout, plus a sequential queue for relayed voice notes so two clips can
 * never talk over each other.
 *
 * iOS autoplay: `play()` must be called inside the join gesture chain. If it
 * rejects anyway we surface a one-tap "enable sound" banner rather than silently
 * playing nothing.
 */

import { debugLog, notify, state } from '../state';

const elements = new Map<string, HTMLAudioElement>();
const clipQueue: string[] = [];
let clipPlaying = false;
let unlocked = false;

function createElement(peerId: string): HTMLAudioElement {
  const el = document.createElement('audio');
  el.autoplay = true;
  el.controls = false;
  // Attribute, not property: `playsInline` is not typed everywhere.
  el.setAttribute('playsinline', '');
  el.dataset['peer'] = peerId;
  el.style.display = 'none';
  document.body.append(el);
  elements.set(peerId, el);
  return el;
}

/** Attach a remote stream to this peer's audio element. */
export function attachPeerAudio(peerId: string, stream: MediaStream): void {
  const el = elements.get(peerId) ?? createElement(peerId);
  el.srcObject = stream;
  void tryPlay(el);
}

/** Remove a peer's audio element and release the stream reference. */
export function detachPeerAudio(peerId: string): void {
  const el = elements.get(peerId);
  if (!el) return;
  el.srcObject = null;
  el.remove();
  elements.delete(peerId);
}

async function tryPlay(el: HTMLAudioElement): Promise<void> {
  try {
    await el.play();
    if (state.needsSoundTap) {
      state.needsSoundTap = false;
      notify();
    }
  } catch (err) {
    // NotAllowedError: no gesture yet. Ask for one tap instead of failing silently.
    debugLog('autoplay-blocked', err);
    state.needsSoundTap = true;
    notify();
  }
}

/**
 * Called from the join gesture: plays a silent buffer through every element so the
 * browser marks them as user-activated.
 */
export function unlockPlayback(): void {
  unlocked = true;
  for (const el of elements.values()) void tryPlay(el);
}

/** Retry after the user taps the "enable sound" banner. */
export function retryPlayback(): void {
  state.needsSoundTap = false;
  for (const el of elements.values()) void tryPlay(el);
  notify();
}

/** True once a gesture has flowed through {@link unlockPlayback}. */
export function playbackUnlocked(): boolean {
  return unlocked;
}

/**
 * Queue a relayed voice note. Clips play strictly one at a time: overlapping
 * relayed audio is unintelligible and, worse, it is confusing about who spoke.
 */
export function enqueueClip(url: string): void {
  clipQueue.push(url);
  void pumpClips();
}

async function pumpClips(): Promise<void> {
  if (clipPlaying) return;
  const url = clipQueue.shift();
  if (url === undefined) return;
  clipPlaying = true;
  const el = new Audio(url);
  el.setAttribute('playsinline', '');
  try {
    await el.play();
    await new Promise<void>((resolve) => {
      el.onended = () => resolve();
      el.onerror = () => resolve();
    });
  } catch (err) {
    debugLog('clip-play', err);
    state.needsSoundTap = true;
    notify();
  } finally {
    clipPlaying = false;
  }
  void pumpClips();
}

/** Stop everything and drop every element. Used by panic and channel leave. */
export function stopAllPlayback(): void {
  clipQueue.length = 0;
  for (const peerId of [...elements.keys()]) detachPeerAudio(peerId);
}
