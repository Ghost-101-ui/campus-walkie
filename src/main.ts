/**
 * Campus Walkie — Application Entry Point.
 *
 * Coordinates key derivation, session identity, signaling client, WebRTC mesh,
 * audio hardware, state subscriptions, and DOM UI rendering.
 */

import './index.css';
import { deriveChannelKeysInWorker } from './crypto/kdf';
import { createIdentity, type Identity } from './crypto/identity';
import { openMic } from './audio/ptt';
import { unlockPlayback, stopAllPlayback } from './audio/playback';
import { Mesh } from './net/mesh';
import { SignalingClient } from './net/signaling';
import { splitPayload, fileFrame, type Completed, type FileMeta } from './net/datachannel';
import { addMessage, debugLog, resetState, state, subscribe, systemMessage } from './state';
import { renderJoinScreen, type JoinOptions } from './ui/join';
import { renderChannelScreen } from './ui/channel';
import type { Frame } from './types';

let currentIdentity: Identity | null = null;
let currentSignaling: SignalingClient | null = null;
let currentMesh: Mesh | null = null;

let isDeriving = false;
let kdfProgress = 0;
let joinError = '';

const appRoot = document.getElementById('app');

/** Re-renders the UI whenever state changes. */
function render(): void {
  if (!appRoot) return;

  if (state.screen === 'join') {
    renderJoinScreen(appRoot, handleJoin, isDeriving, kdfProgress, joinError);
  } else {
    renderChannelScreen(appRoot, {
      onLeave: handleLeave,
      onPanic: handlePanic,
      onSendText: handleSendText,
      onSendFile: handleSendFile,
    });
  }
}

// Subscribe state to UI updates
subscribe(render);

async function handleJoin(opts: JoinOptions): Promise<void> {
  isDeriving = true;
  kdfProgress = 0;
  joinError = '';
  render();

  try {
    requireSecureCrypto();

    // 1. Derive channel keys in worker
    const { channelKey, channelId } = await deriveChannelKeysInWorker(
      opts.channel,
      opts.passphrase,
      (_progress) => {
        kdfProgress = Math.min(95, kdfProgress + 20);
        render();
      }
    );
    kdfProgress = 100;
    render();

    // 2. Generate non-extractable session identity
    currentIdentity = await createIdentity();
    state.peerId = currentIdentity.peerId;
    state.sigAlg = currentIdentity.alg;
    state.name = opts.name;
    state.channel = opts.channel;
    sessionStorage.setItem('cw_passphrase', opts.passphrase);

    // 3. Unlock audio autoplay & request microphone track
    unlockPlayback();
    const track = await openMic();

    // 4. Create Signaling Client
    const relayUrl = opts.relay || import.meta.env.VITE_RELAY_URL || 'wss://campus-walkie-relay.workers.dev';

    currentSignaling = new SignalingClient(
      relayUrl,
      channelId,
      channelKey,
      currentIdentity,
      {
        onWelcome: (_you, peers) => {
          currentMesh?.onWelcome(peers);
        },
        onJoin: (connId) => {
          currentMesh?.onJoin(connId);
        },
        onLeave: (connId) => {
          currentMesh?.onLeave(connId);
        },
        onSignal: (connId, peerId, pub, signal) => {
          void currentMesh?.onSignal(connId, peerId, pub, signal);
        },
        onState: (linkState) => {
          state.link = linkState;
          render();
        },
      }
    );

    // 5. Create WebRTC Mesh
    currentMesh = new Mesh(
      currentIdentity,
      channelId,
      channelKey,
      currentSignaling,
      {
        onFrame: (peerId, frame, relayed) => handleIncomingFrame(peerId, frame, relayed),
        onPayload: (peerId, payload, relayed) => handleIncomingPayload(peerId, payload, relayed),
        onPayloadTimeout: (peerId, meta) => handlePayloadTimeout(peerId, meta),
      }
    );

    if (track) currentMesh.setLocalTrack(track);

    // 6. Connect to signaling server
    currentSignaling.connect();

    state.screen = 'channel';
    systemMessage(`Joined room #${opts.channel} as ${opts.name}`);
  } catch (err) {
    debugLog('join-error', err);
    joinError = err instanceof Error ? err.message : 'Failed to derive keys or connect';
  } finally {
    isDeriving = false;
    render();
  }
}

/** Web Crypto is deliberately unavailable to ordinary HTTP pages. */
function requireSecureCrypto(): void {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error('Secure connection required. Open Campus Walkie using HTTPS; http://localhost is supported only for testing on this computer.');
  }
}

function handleIncomingFrame(peerId: string, frame: Frame, relayed: boolean): void {
  const peer = currentMesh?.peerByPeerId(peerId);
  const fromName = peer?.name || 'Peer';

  if (frame.k === 'text') {
    addMessage({
      id: frame.id,
      kind: 'text',
      from: peerId,
      fromName,
      mine: false,
      ts: Date.now(),
      body: frame.body,
      relayed,
    });
    if (state.screen === 'channel') {
      state.unread++;
    }
  }
}

function handleIncomingPayload(peerId: string, payload: Completed, relayed: boolean): void {
  const peer = currentMesh?.peerByPeerId(peerId);
  const fromName = peer?.name || 'Peer';

  const blob = new Blob([payload.bytes.buffer as ArrayBuffer], { type: payload.meta.mime });
  const url = URL.createObjectURL(blob);

  const isVoice = payload.meta.mime.startsWith('audio/');

  addMessage({
    id: payload.meta.id,
    kind: isVoice ? 'voice' : 'file',
    from: peerId,
    fromName,
    mine: false,
    ts: Date.now(),
    body: payload.meta.name,
    relayed,
    url,
    mime: payload.meta.mime,
    size: payload.meta.size,
  });
}

function handlePayloadTimeout(_peerId: string, meta: FileMeta): void {
  systemMessage(`Transfer of ${meta.name} timed out or was interrupted.`);
}

async function handleSendText(text: string): Promise<void> {
  if (!currentMesh) return;

  const id = crypto.randomUUID();
  const frame: Frame = { k: 'text', id, body: text };

  addMessage({
    id,
    kind: 'text',
    from: state.peerId,
    fromName: state.name,
    mine: true,
    ts: Date.now(),
    body: text,
    relayed: false,
  });

  await currentMesh.broadcast(frame);
}

async function handleSendFile(file: File): Promise<void> {
  if (!currentMesh) return;

  const id = crypto.randomUUID();
  const buffer = new Uint8Array(await file.arrayBuffer());

  const metaFrame = fileFrame(id, file.name, file.type || 'application/octet-stream', file.size);
  const chunks = splitPayload(id, buffer);

  const url = URL.createObjectURL(file);

  addMessage({
    id,
    kind: file.type.startsWith('audio/') ? 'voice' : 'file',
    from: state.peerId,
    fromName: state.name,
    mine: true,
    ts: Date.now(),
    body: file.name,
    relayed: false,
    url,
    size: file.size,
  });

  await currentMesh.broadcast(metaFrame);

  for (const chunk of chunks) {
    await currentMesh.broadcast(chunk);
  }
}

function handleLeave(): void {
  currentSignaling?.close();
  currentMesh?.destroy();
  stopAllPlayback();
  sessionStorage.removeItem('cw_passphrase');
  resetState();
  currentIdentity = null;
  currentSignaling = null;
  currentMesh = null;
  render();
}

function handlePanic(): void {
  handleLeave();
  localStorage.clear();
  systemMessage('All state, memory keys, and storage wiped.');
}

// Service worker registration
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.onupdatefound = () => {
        const installing = reg.installing;
        if (installing) {
          installing.onstatechange = () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              state.updateReady = true;
              render();
            }
          };
        }
      };
    }).catch((err) => debugLog('sw-register-failed', err));
  });
}

// Initial render
render();
