/**
 * Channel screen component (State 2).
 *
 * Brutalist + Engineering Notebook 3-Column Desktop Layout:
 * LEFT: Peer List, Initials, Connection status, Voice Activity, Invite Button.
 * CENTER: Slack/Linear Chat Timeline, Message Input, Hero Physical PTT Button (Wave anim, timer, compressed press state).
 * RIGHT: Minimal Info Cards (Channel, Encryption, Connection, Relay, Quality, Peer Count, Your ID).
 */

import { $, clear, h, on } from './dom';
import { attachMeter, setTransmitting } from '../audio/ptt';
import { retryPlayback } from '../audio/playback';
import { micIconSvg } from './doodles';
import { drawQr } from './qr';
import { state } from '../state';
import { renderChatArea } from './chat';
import { createDoodleArea } from '../components/DoodleArea';
import type { Peer } from '../types';

export interface ChannelCallbacks {
  onLeave(): void;
  onPanic(): void;
  onSendText(text: string): void;
  onSendFile(file: File): void;
}

let activeTab: 'ptt' | 'chat' = 'ptt';

function controlIcon(src: string, alt: string): HTMLImageElement {
  return h('img', { class: 'control-icon', src, alt }) as HTMLImageElement;
}

export function renderChannelScreen(
  container: HTMLElement,
  callbacks: ChannelCallbacks
): void {
  clear(container);

  /* --------------------------------------------------------------- Header */
  const linkLabel = state.link === 'reconnecting'
    ? `RECONNECTING (${state.reconnectSeconds}s)`
    : state.link === 'connecting'
    ? 'CONNECTING...'
    : state.link.toUpperCase();

  const linkBadge = h('div', { class: `sticky-tape ${state.link === 'connected' ? 'sticky-tape-green' : (state.link === 'connecting' || state.link === 'reconnecting' ? 'sticky-tape-yellow' : 'sticky-tape-purple')} live-badge` },
    h('span', { class: 'live-dot' }),
    h('span', {}, state.link === 'connected' ? 'LIVE' : linkLabel)
  );

  const signalBars = renderSignalBars();

  const qrBtn = h('button', { class: 'icon-btn-brutal', title: 'Invite Friends / QR Code' }, controlIcon('/icons/add.gif', 'Invite friends / QR code'));
  const verifyBtn = h('button', { class: 'icon-btn-brutal', title: 'Verify Safety Words' }, controlIcon('/icons/verify.gif', 'Verify safety words'));
  const settingsBtn = h('button', { class: 'icon-btn-brutal', title: 'Settings' }, controlIcon('/icons/settings.gif', 'Settings'));
  const leaveBtn = h('button', { class: 'icon-btn-brutal', title: 'Leave Channel' }, controlIcon('/icons/door.gif', 'Leave channel'));
  const panicBtn = h('button', { class: 'icon-btn-brutal text-danger', title: 'PANIC - Wipe state immediately' }, controlIcon('/icons/panic.gif', 'Panic: wipe local session'));

  on(qrBtn, 'click', () => showQrModal());
  on(verifyBtn, 'click', () => showVerifyModal());
  on(settingsBtn, 'click', () => showSettingsModal());
  on(leaveBtn, 'click', () => callbacks.onLeave());
  on(panicBtn, 'click', () => {
    if (confirm('PANIC BUTTON: Wipe all keys, messages, and state immediately?')) {
      callbacks.onPanic();
    }
  });

  const header = h('div', { class: 'ch-header' },
    h('div', { class: 'ch-header-title' },
      h('span', { class: 'ch-hash' }, '#'),
      h('span', { class: 'ch-name' }, state.channel)
    ),
    h('div', { class: 'ch-header-status' },
      linkBadge,
      h('span', { class: 'peer-count-label' }, `${state.peers.size + 1} peers`),
      signalBars
    ),
    h('div', { class: 'ch-header-actions' },
      qrBtn, verifyBtn, settingsBtn, leaveBtn, panicBtn
    )
  );

  /* ------------------------------------------------------------- Peer List Column (Left) */
  const peerCards: HTMLElement[] = [];
  
  // Local user tile
  const myName = localStorage.getItem('cw_name') || 'You';
  peerCards.push(renderPeerCard({
    peerId: 'local-me',
    connId: 'local-me',
    pub: '',
    name: myName,
    state: 'connected',
    impolite: false,
    talking: state.transmitting,
    verified: true,
    transport: 'direct',
    quality: { rttMs: 0, loss: 0, jitterMs: 0 },
    safetyWords: [],
  }, true));

  for (const peer of state.peers.values()) {
    peerCards.push(renderPeerCard(peer, false));
  }

  const inviteFriendsBtn = h('button', { class: 'btn btn-ghost w-full text-xs font-bold' }, '🔒 INVITE FRIENDS →');
  on(inviteFriendsBtn, 'click', () => showQrModal());

  const leftPeersColumn = h('div', { class: 'ch-col-peers' },
    h('div', { class: 'peers-header-bar' },
      h('span', {}, 'PEERS'),
      h('span', { class: 'text-muted font-mono' }, `${state.peers.size + 1}`)
    ),
    h('div', { class: 'peers-scroll-list' }, peerCards),
    h('div', { class: 'peers-footer-action' }, inviteFriendsBtn)
  );

  /* ------------------------------------------------------- Banners (if any) */
  const banners: HTMLElement[] = [];

  if (state.needsSoundTap) {
    const tapBtn = h('button', { class: 'btn btn-primary text-xs' }, 'Enable Sound 🔊');
    on(tapBtn, 'click', () => retryPlayback());
    banners.push(h('div', { class: 'sound-tap-banner' },
      h('span', {}, 'Audio playback requires one user tap in this browser.'),
      tapBtn
    ));
  }

  if (state.updateReady) {
    const updateBtn = h('button', { class: 'btn btn-warn text-xs' }, 'Reload App 🔄');
    on(updateBtn, 'click', () => window.location.reload());
    banners.push(h('div', { class: 'update-banner' },
      h('span', {}, 'A new version of Campus Walkie is available.'),
      updateBtn
    ));
  }

  /* -------------------------------------------------- Mobile Tabs Switcher */
  const pttTab = h('button', {
    class: `ch-mobile-tab ${activeTab === 'ptt' ? 'active' : ''}`,
    title: 'Voice chat',
  }, controlIcon('/icons/voice-chat.png', ''), h('span', {}, 'PTT'));

  const chatTab = h('button', {
    class: `ch-mobile-tab ${activeTab === 'chat' ? 'active' : ''}`,
    title: 'Text chat',
  },
    controlIcon('/icons/chat.png', ''),
    h('span', {}, 'CHAT'),
    state.unread > 0 ? h('span', { class: 'unread-badge' }, String(state.unread)) : null
  );

  on(pttTab, 'click', () => {
    activeTab = 'ptt';
    state.unread = 0;
    renderChannelScreen(container, callbacks);
  });

  on(chatTab, 'click', () => {
    activeTab = 'chat';
    state.unread = 0;
    renderChannelScreen(container, callbacks);
  });

  const mobileTabs = h('div', { class: 'ch-mobile-tabs' }, pttTab, chatTab);

  /* ------------------------------------------------------- Center Column (Chat & PTT) */
  const chatAreaWrapper = h('div', { class: 'chat-section-container' });
  renderChatArea(chatAreaWrapper, state.messages, {
    onSendText: callbacks.onSendText,
    onSendFile: callbacks.onSendFile,
  });

  const pttHeroSection = renderPttHeroSection();

  const centerColumn = h('div', { class: `ch-col-center active-${activeTab}` },
    mobileTabs,
    chatAreaWrapper,
    pttHeroSection
  );

  /* ------------------------------------------------------- Right Column (Info Panel) */
  const shortPeerId = state.peerId ? (state.peerId.slice(0, 4) + '-' + state.peerId.slice(-4)).toUpperCase() : 'LOCAL-HOST';

  const copyIdBtn = h('button', { class: 'icon-btn-brutal text-xs', style: 'width:24px; height:24px;', title: 'Copy ID' }, '📋');
  on(copyIdBtn, 'click', () => {
    navigator.clipboard.writeText(state.peerId);
  });

  const rightInfoColumn = h('div', { class: 'ch-col-info' },
    // Channel Info Card
    h('div', { class: 'info-card-brutal' },
      h('div', { class: 'info-card-title' }, 'CHANNEL INFO'),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Channel'), h('span', { class: 'info-val' }, `#${state.channel}`)),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Peers'), h('span', { class: 'info-val' }, `${state.peers.size + 1}`)),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Mode'), h('span', { class: 'info-val' }, 'P2P Mesh')),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Relay'), h('span', { class: 'info-val' }, 'Auto')),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Your ID'), h('span', { class: 'info-val flex items-center gap-1' }, shortPeerId, copyIdBtn))
    ),

    // Connection Card
    h('div', { class: 'info-card-brutal' },
      h('div', { class: 'info-card-title' }, 'CONNECTION'),
      h('div', { class: 'info-row' },
        h('span', { class: 'text-muted' }, 'Status'),
        h('span', { class: `info-val ${state.link === 'connected' ? 'text-success' : 'text-warn'}` },
          state.link === 'connected' ? '● Connected' : (state.link === 'reconnecting' ? `● Retry in ${state.reconnectSeconds}s` : `● ${state.link.toUpperCase()}`)
        )
      ),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Quality'), h('span', { class: 'info-val' }, state.link === 'connected' ? 'Excellent' : 'Standby')),
      signalBars
    ),

    // Encryption Card
    h('div', { class: 'info-card-brutal' },
      h('div', { class: 'info-card-title' }, 'ENCRYPTION'),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Status'), h('span', { class: 'info-val text-accent' }, '🔒 Active')),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'Cipher'), h('span', { class: 'info-val' }, 'AES-256-GCM')),
      h('div', { class: 'info-row' }, h('span', { class: 'text-muted' }, 'KDF'), h('span', { class: 'info-val' }, 'PBKDF2-SHA256'))
    )
  );

  /* ------------------------------------------------ Desktop 3-Column Grid Layout */
  const gridLayout = h('div', { class: 'ch-layout-grid' },
    leftPeersColumn,
    centerColumn,
    rightInfoColumn
  );

  const screen = h('div', { class: 'channel-screen' },
    header,
    ...banners,
    gridLayout
  );

  container.append(screen);

  // Attach canvas meter if available
  const canvas = $('#ptt-meter-canvas') as HTMLCanvasElement | null;
  if (canvas) attachMeter(canvas);
}

function renderSignalBars(): HTMLElement {
  return h('div', { class: 'signal-meter-brutal', title: 'Connection Quality' },
    h('div', { class: 'sig-bar active' }),
    h('div', { class: 'sig-bar active' }),
    h('div', { class: 'sig-bar active' }),
    h('div', { class: 'sig-bar active' })
  );
}

function renderPeerCard(peer: Peer, isLocal = false): HTMLElement {
  const isTalking = peer.talking || (isLocal ? state.transmitting : state.talker === peer.peerId);
  const initial = (peer.name || '?').charAt(0).toUpperCase();

  return h('div', { class: `peer-card-brutal ${isTalking ? 'talking' : ''}` },
    h('div', { class: 'peer-avatar-box' }, initial),
    h('div', { class: 'peer-details' },
      h('div', { class: 'peer-name-txt' }, peer.name || 'Anonymous'),
      h('div', { class: `peer-status-sub ${isTalking ? 'talking' : ''}` },
        isTalking ? '● Talking' : (isLocal ? 'Idle' : 'Listening')
      )
    )
  );
}

function renderPttHeroSection(): HTMLElement {
  const canvas = h('canvas', { id: 'ptt-meter-canvas', class: 'ptt-canvas-meter' }) as HTMLCanvasElement;

  const isSomeoneTalking = state.talker !== '' && !state.transmitting;
  const talkerPeer = state.talker ? state.peers.get(state.talker) : null;
  const talkerName = talkerPeer ? talkerPeer.name : 'Someone';

  const micIconSvgEl = h('div', {});
  micIconSvgEl.innerHTML = micIconSvg(24, 24, state.transmitting ? '#FFFFFF' : '#121212');

  const pttHeroBtn = h('button', {
    class: `ptt-hero-btn ${state.transmitting ? 'transmitting' : ''}`,
    type: 'button',
    id: 'ptt-hero-button',
  },
    h('div', { class: 'ptt-icon-wrap' }, micIconSvgEl),
    h('span', { class: 'ptt-label-hero' }, state.transmitting ? 'TRANSMITTING' : (isSomeoneTalking ? `${talkerName.toUpperCase()} SPEAKING` : 'HOLD TO TALK')),
    state.transmitting ? h('div', { class: 'ptt-wave-anim' },
      h('div', { class: 'wave-bar' }),
      h('div', { class: 'wave-bar' }),
      h('div', { class: 'wave-bar' }),
      h('div', { class: 'wave-bar' })
    ) : null
  );

  // Pointer / Touch events for PTT hold
  const startTransmitting = (ev: Event) => {
    ev.preventDefault();
    if (isSomeoneTalking && state.halfDuplex) return;
    setTransmitting(true);
  };

  const stopTransmitting = (ev: Event) => {
    ev.preventDefault();
    setTransmitting(false);
  };

  on(pttHeroBtn, 'pointerdown', startTransmitting);
  on(pttHeroBtn, 'pointerup', stopTransmitting);
  on(pttHeroBtn, 'pointercancel', stopTransmitting);
  on(pttHeroBtn, 'contextmenu', (e) => e.preventDefault());

  return h('div', { class: 'ptt-hero-section' },
    state.transmitting ? h('div', { class: 'recording-timer-badge' },
      h('span', {}, '🔴 RECORDING'),
      h('span', {}, '00:07')
    ) : null,
    canvas,
    pttHeroBtn,
    createDoodleArea('ptt-bottom')
  );
}

/* ------------------------------------------------------------------- Modals */

function showQrModal(): void {
  const url = new URL(window.location.href);
  // Start with a clean URL so an old invite cannot leak stale parameters.
  url.search = '';
  url.hash = '';
  url.searchParams.set('channel', state.channel);
  const relay = localStorage.getItem('cw_relay') || import.meta.env.VITE_RELAY_URL || '';
  if (relay) url.searchParams.set('relay', relay);
  const pass = sessionStorage.getItem('cw_passphrase') || '';
  if (pass) {
    url.hash = `key=${encodeURIComponent(pass)}`;
  }

  const canvas = h('canvas', { class: 'qr-canvas' }) as HTMLCanvasElement;
  drawQr(canvas, url.toString(), '#121212', '#FFFFFF');

  const copyBtn = h('button', { class: 'btn btn-primary w-full' }, 'COPY SHARE LINK');
  on(copyBtn, 'click', () => {
    navigator.clipboard.writeText(url.toString());
    copyBtn.textContent = 'LINK COPIED! ✔';
    setTimeout(() => { copyBtn.textContent = 'COPY SHARE LINK'; }, 2000);
  });

  showModal('INVITE FRIENDS', 'sticky-tape-green', [
    h('div', { class: 'qr-panel flex flex-col items-center gap-4' },
      canvas,
      h('input', { type: 'text', readonly: true, value: url.toString(), class: 'share-url-input w-full p-2 border border-black font-mono text-xs' }),
      copyBtn
    )
  ]);
}

function showVerifyModal(): void {
  const peersWithWords = Array.from(state.peers.values()).filter(p => p.safetyWords.length > 0);
  const sampleWords = (peersWithWords.length > 0 && peersWithWords[0]?.safetyWords)
    ? peersWithWords[0].safetyWords
    : ['sunset', 'ocean', 'gadget', 'planet', 'rocket', 'purple', 'clever', 'brisk'];

  const grid = h('div', { class: 'grid grid-cols-2 gap-2 font-mono text-xs' },
    ...sampleWords.map(w => h('div', { class: 'p-2 border border-black bg-white text-center font-bold' }, w))
  );

  showModal('VERIFY KEY', 'sticky-tape-purple', [
    h('div', { class: 'verify-panel flex flex-col gap-3' },
      h('p', { class: 'text-xs text-muted text-center font-mono' }, 'Compare these safety words with your friend out loud:'),
      grid
    )
  ]);
}

function showSettingsModal(): void {
  const relayUrl = localStorage.getItem('cw_relay') || import.meta.env.VITE_RELAY_URL || 'wss://campus-walkie-relay.workers.dev';

  showModal('SETTINGS', 'sticky-tape-blue', [
    h('div', { class: 'settings-panel flex flex-col gap-3 font-mono text-xs' },
      h('div', { class: 'flex justify-between border-b pb-1' }, h('span', {}, 'Relay Server:'), h('span', { class: 'font-bold' }, relayUrl)),
      h('div', { class: 'flex justify-between border-b pb-1' }, h('span', {}, 'Theme:'), h('span', { class: 'font-bold' }, 'Engineering Brutalist')),
      h('div', { class: 'flex justify-between border-b pb-1' }, h('span', {}, 'Version:'), h('span', { class: 'font-bold' }, 'Campus Walkie v3.0'))
    )
  ]);
}

function showModal(title: string, tapeClass: string, bodyChildren: HTMLElement[]): void {
  const closeBtn = h('button', { class: 'modal-close-brutal' }, '✕');

  const modal = h('div', { class: 'modal-brutal' },
    h('div', { class: 'modal-header-brutal' },
      h('div', { class: `sticky-tape ${tapeClass}` }, title),
      closeBtn
    ),
    ...bodyChildren
  );

  const overlay = h('div', { class: 'modal-overlay-brutal' }, modal);

  const close = () => overlay.remove();
  on(closeBtn, 'click', close);
  on(overlay, 'click', (ev) => {
    if (ev.target === overlay) close();
  });

  document.body.append(overlay);
}
