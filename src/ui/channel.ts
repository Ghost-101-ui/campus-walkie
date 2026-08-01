/**
 * Channel screen component (State 2).
 *
 * Brutalist + Engineering Notebook 3-Column Desktop Layout:
 * LEFT: Peer List, Initials, Connection status, Voice Activity, Invite Button.
 * CENTER: Slack/Linear Chat Timeline, Message Input, Hero Physical PTT Button (Wave anim, timer, compressed press state).
 * RIGHT: Minimal Info Cards (Channel, Encryption, Connection, Relay, Quality, Peer Count, Your ID).
 */

import { $, clear, h, icon, on } from './dom';
import { attachMeter, setTransmitting } from '../audio/ptt';
import { setVoiceFilter, setOutputVolume } from '../audio/voicefx';
import { retryPlayback } from '../audio/playback';
import { micIconSvg } from './doodles';
import { drawQr } from './qr';
import { state } from '../state';
import { renderChatArea } from './chat';
import { createDoodleArea } from '../components/DoodleArea';
import type { Peer } from '../types';
import type { VoiceFilter } from '../state';

export interface ChannelCallbacks {
  onLeave(): void;
  onPanic(): void;
  onSendText(text: string): void;
  onSendFile(file: File): void;
}

let activeTab: 'ptt' | 'chat' | 'peers' = 'ptt';

function controlIcon(src: string, alt: string): HTMLImageElement {
  return h('img', { class: 'control-icon', src, alt }) as HTMLImageElement;
}

export function renderChannelScreen(
  container: HTMLElement,
  callbacks: ChannelCallbacks
): void {
  let screen = container.querySelector('.channel-screen') as HTMLElement | null;

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

  const qrBtn = h('button', { class: 'icon-btn-brutal', title: 'Invite Friends / QR Code' }, controlIcon(icon('add.gif'), 'Invite friends / QR code'));
  const verifyBtn = h('button', { class: 'icon-btn-brutal', title: 'Verify Safety Words' }, controlIcon(icon('verify.gif'), 'Verify safety words'));
  const settingsBtn = h('button', { class: 'icon-btn-brutal', title: 'Settings' }, controlIcon(icon('settings.gif'), 'Settings'));
  const leaveBtn = h('button', { class: 'icon-btn-brutal', title: 'Leave Channel' }, controlIcon(icon('door.gif'), 'Leave channel'));
  const panicBtn = h('button', { class: 'icon-btn-brutal text-danger', title: 'PANIC - Wipe state immediately' }, controlIcon(icon('panic.gif'), 'Panic: wipe local session'));

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
  const bannersList: HTMLElement[] = [];

  if (state.needsSoundTap) {
    const tapBtn = h('button', { class: 'btn btn-primary text-xs' }, 'Enable Sound 🔊');
    on(tapBtn, 'click', () => retryPlayback());
    bannersList.push(h('div', { class: 'sound-tap-banner' },
      h('span', {}, 'Audio playback requires one user tap in this browser.'),
      tapBtn
    ));
  }

  if (state.updateReady) {
    const updateBtn = h('button', { class: 'btn btn-warn text-xs' }, 'Reload App 🔄');
    on(updateBtn, 'click', () => window.location.reload());
    bannersList.push(h('div', { class: 'update-banner' },
      h('span', {}, 'A new version of Campus Walkie is available.'),
      updateBtn
    ));
  }

  const bannersWrapper = h('div', { class: 'ch-banners-wrapper' }, ...bannersList);

  /* -------------------------------------------------- Mobile Tabs Switcher */
  const pttTab = h('button', {
    class: `ch-mobile-tab ${activeTab === 'ptt' ? 'active' : ''}`,
    title: 'Voice chat',
  }, controlIcon(icon('voice-chat.png'), ''), h('span', {}, 'PTT'));

  const chatTab = h('button', {
    class: `ch-mobile-tab ${activeTab === 'chat' ? 'active' : ''}`,
    title: 'Text chat',
  },
    controlIcon(icon('chat.png'), ''),
    h('span', {}, 'CHAT'),
    state.unread > 0 ? h('span', { class: 'unread-badge' }, String(state.unread)) : null
  );

  const peersTab = h('button', {
    class: `ch-mobile-tab ${activeTab === 'peers' ? 'active' : ''}`,
    title: 'Peers list',
  },
    controlIcon(icon('group.png'), ''),
    h('span', {}, 'PEERS'),
    h('span', { class: 'peer-count-badge unread-badge' }, String(state.peers.size + 1))
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

  on(peersTab, 'click', () => {
    activeTab = 'peers';
    renderChannelScreen(container, callbacks);
  });

  const mobileTabs = h('div', { class: 'ch-mobile-tabs' }, pttTab, chatTab, peersTab);

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

  /* ------------------------------------------------ If screen already exists, update in-place! */
  if (screen) {
    const oldHeader = screen.querySelector('.ch-header');
    if (oldHeader) oldHeader.replaceWith(header);

    const oldBanners = screen.querySelector('.ch-banners-wrapper');
    if (oldBanners) oldBanners.replaceWith(bannersWrapper);

    const gridLayout = screen.querySelector('.ch-layout-grid');
    if (gridLayout) {
      gridLayout.className = `ch-layout-grid mobile-active-${activeTab}`;
      
      const oldLeft = gridLayout.querySelector('.ch-col-peers');
      if (oldLeft) oldLeft.replaceWith(leftPeersColumn);

      const oldRight = gridLayout.querySelector('.ch-col-info');
      if (oldRight) oldRight.replaceWith(rightInfoColumn);

      const oldTabs = gridLayout.querySelector('.ch-mobile-tabs');
      if (oldTabs) oldTabs.replaceWith(mobileTabs);

      const chatAreaWrapper = gridLayout.querySelector('.chat-section-container') as HTMLElement | null;
      if (chatAreaWrapper) {
        renderChatArea(chatAreaWrapper, state.messages, {
          onSendText: callbacks.onSendText,
          onSendFile: callbacks.onSendFile,
        });
      }

      const pttHeroSection = gridLayout.querySelector('.ptt-hero-section');
      if (pttHeroSection) {
        const pulseRing = pttHeroSection.querySelector('.pulse-ring');
        const heroBtn = pttHeroSection.querySelector('.ptt-hero-btn');
        const pttLabel = heroBtn?.querySelector('.ptt-label-hero');
        const subHint = pttHeroSection.querySelector('.ptt-sub-hint');
        const isSomeoneTalking = state.talker !== '' && !state.transmitting;
        const talkerPeer = state.talker ? state.peers.get(state.talker) : null;
        const talkerName = talkerPeer ? talkerPeer.name : 'Someone';

        if (state.transmitting) {
          pulseRing?.classList.add('active');
          heroBtn?.classList.add('transmitting');
          if (state.pttLatched) {
            heroBtn?.classList.add('latched');
            if (pttLabel) pttLabel.textContent = '🔒 HANDS-FREE ON (CLICK TO STOP)';
            if (subHint) subHint.textContent = '🔒 Hands-Free Locked — Click or Double-Click to turn off';
          } else {
            heroBtn?.classList.remove('latched');
            if (pttLabel) pttLabel.textContent = 'TRANSMITTING';
            if (subHint) subHint.textContent = '⚡ Release to stop • Double-click to lock hands-free';
          }
        } else {
          pulseRing?.classList.remove('active');
          heroBtn?.classList.remove('transmitting', 'latched');
          if (pttLabel) {
            pttLabel.textContent = isSomeoneTalking ? `${talkerName.toUpperCase()} SPEAKING` : 'HOLD TO TALK';
          }
          if (subHint) {
            subHint.textContent = '💡 Hold to talk • Double-click for hands-free mode';
          }
        }
      }
    }
    return;
  }

  /* ------------------------------------------------ Initial First Render */
  clear(container);

  const chatAreaWrapper = h('div', { class: 'chat-section-container' });
  renderChatArea(chatAreaWrapper, state.messages, {
    onSendText: callbacks.onSendText,
    onSendFile: callbacks.onSendFile,
  });

  const pttHeroSection = renderPttHeroSection();

  const centerColumn = h('div', { class: `ch-col-center` },
    mobileTabs,
    chatAreaWrapper,
    pttHeroSection
  );

  const gridLayout = h('div', { class: `ch-layout-grid mobile-active-${activeTab}` },
    leftPeersColumn,
    centerColumn,
    rightInfoColumn
  );

  screen = h('div', { class: 'channel-screen' },
    header,
    bannersWrapper,
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
        isTalking ? (state.pttLatched && isLocal ? '🔒 Hands-Free' : '● Talking') : (isLocal ? 'Idle' : 'Listening')
      )
    )
  );
}

let lastPointerDownTime = 0;

function renderPttHeroSection(): HTMLElement {
  const canvas = h('canvas', { id: 'ptt-meter-canvas', class: 'ptt-canvas-meter' }) as HTMLCanvasElement;

  const isSomeoneTalking = state.talker !== '' && !state.transmitting;
  const talkerPeer = state.talker ? state.peers.get(state.talker) : null;
  const talkerName = talkerPeer ? talkerPeer.name : 'Someone';

  const micIconSvgEl = h('div', {});
  micIconSvgEl.innerHTML = micIconSvg(24, 24, state.transmitting ? '#FFFFFF' : '#121212');

  const getLabelText = () => {
    if (state.transmitting) {
      return state.pttLatched ? '🔒 HANDS-FREE ON (CLICK TO STOP)' : 'TRANSMITTING';
    }
    return isSomeoneTalking ? `${talkerName.toUpperCase()} SPEAKING` : 'HOLD TO TALK';
  };

  const getSubHintText = () => {
    if (state.transmitting && state.pttLatched) {
      return '🔒 Hands-Free Locked — Click or Double-Click to turn off';
    }
    if (state.transmitting) {
      return '⚡ Release to stop • Double-click to lock hands-free';
    }
    return '💡 Hold to talk • Double-click for hands-free mode';
  };

  const pttHeroBtn = h('button', {
    class: `ptt-hero-btn ${state.transmitting ? 'transmitting' : ''} ${state.pttLatched ? 'latched' : ''}`,
    type: 'button',
    id: 'ptt-hero-button',
  },
    h('div', { class: 'ptt-icon-wrap' }, micIconSvgEl),
    h('span', { class: 'ptt-label-hero' }, getLabelText()),
    state.transmitting ? h('div', { class: 'ptt-wave-anim' },
      h('div', { class: 'wave-bar' }),
      h('div', { class: 'wave-bar' }),
      h('div', { class: 'wave-bar' }),
      h('div', { class: 'wave-bar' })
    ) : null
  );

  const subHint = h('div', { class: 'ptt-sub-hint' }, getSubHintText());

  // Pointer / Touch events for PTT hold and double-click latching
  const handlePointerDown = (ev: PointerEvent) => {
    ev.preventDefault();
    if (isSomeoneTalking && state.halfDuplex && !state.transmitting) return;

    // Pointer capture prevents "stuck PTT" when cursor or finger moves outside
    try {
      (ev.currentTarget as HTMLElement)?.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    const now = Date.now();
    const delta = now - lastPointerDownTime;

    if (delta > 0 && delta < 350) {
      // Double Click / Double Tap detected!
      lastPointerDownTime = 0;
      state.pttLatched = !state.pttLatched;
      setTransmitting(state.pttLatched);
      return;
    }

    lastPointerDownTime = now;

    if (state.pttLatched) {
      // Single click while latched -> turn OFF hands-free mode
      state.pttLatched = false;
      setTransmitting(false);
      return;
    }

    // Normal Hold-to-Talk start
    setTransmitting(true);
  };

  const handlePointerUp = (ev: PointerEvent) => {
    ev.preventDefault();
    try {
      if ((ev.currentTarget as HTMLElement)?.hasPointerCapture(ev.pointerId)) {
        (ev.currentTarget as HTMLElement)?.releasePointerCapture(ev.pointerId);
      }
    } catch {
      // ignore
    }

    // In latched hands-free mode, do NOT stop transmitting on pointer release
    if (state.pttLatched) return;

    setTransmitting(false);
  };

  on(pttHeroBtn, 'pointerdown', handlePointerDown as EventListener);
  on(pttHeroBtn, 'pointerup', handlePointerUp as EventListener);
  on(pttHeroBtn, 'pointercancel', handlePointerUp as EventListener);
  on(pttHeroBtn, 'contextmenu', (e) => e.preventDefault());

  // Safety fallback: if browser loses focus, release non-latched transmission
  window.addEventListener('blur', () => {
    if (!state.pttLatched && state.transmitting) {
      setTransmitting(false);
    }
  }, { once: true });

  return h('div', { class: 'ptt-hero-section' },
    state.transmitting ? h('div', { class: 'recording-timer-badge' },
      h('span', {}, state.pttLatched ? '🔒 HANDS-FREE' : '🔴 RECORDING'),
      h('span', {}, 'LIVE')
    ) : null,
    canvas,
    pttHeroBtn,
    subHint,
    renderVoiceFilterBar(),
    renderVolumeBar(),
    createDoodleArea('ptt-bottom')
  );
}

/* ------------------------------------------------------------ Voice Filter Bar */

type FilterDef = { id: VoiceFilter; emoji: string; label: string; color: string };

const FILTER_DEFS: FilterDef[] = [
  { id: 'none',      emoji: '🎙️', label: 'CLEAN',  color: '#121212' },
  { id: 'anime',     emoji: '🌸', label: 'ANIME',  color: '#E91E8C' },
  { id: 'radio',     emoji: '📻', label: 'RADIO',  color: '#2962FF' },
  { id: 'robot',     emoji: '🤖', label: 'ROBOT',  color: '#00BCD4' },
  { id: 'megaphone', emoji: '📢', label: 'MEGA',   color: '#FF6D00' },
  { id: 'demon',     emoji: '👿', label: 'DEMON',  color: '#6A1B9A' },
];

function renderVoiceFilterBar(): HTMLElement {
  const buttons = FILTER_DEFS.map((def) => {
    const isActive = state.voiceFilter === def.id;
    const btn = h('button', {
      class: `vfx-filter-btn ${isActive ? 'active' : ''}`,
      title: def.label,
      id: `vfx-btn-${def.id}`,
      style: isActive ? `background:${def.color};border-color:${def.color};color:#fff;` : `border-color:${def.color};color:${def.color};`,
    },
      h('span', { class: 'vfx-emoji' }, def.emoji),
      h('span', { class: 'vfx-label' }, def.label)
    );

    on(btn, 'click', () => {
      state.voiceFilter = def.id;
      setVoiceFilter(def.id);
      // Update button styles in-place without full re-render
      const row = btn.closest('.vfx-filter-row');
      if (row) {
        row.querySelectorAll('.vfx-filter-btn').forEach((b, i) => {
          const d = FILTER_DEFS[i]!;
          const active = d.id === def.id;
          b.classList.toggle('active', active);
          (b as HTMLElement).style.cssText = active
            ? `background:${d.color};border-color:${d.color};color:#fff;`
            : `border-color:${d.color};color:${d.color};`;
        });
      }
    });

    return btn;
  });

  return h('div', { class: 'vfx-filter-row' },
    h('span', { class: 'vfx-row-label' }, 'VOICE FX'),
    h('div', { class: 'vfx-btn-group' }, ...buttons)
  );
}

/* ------------------------------------------------------------ Volume Bar */

function renderVolumeBar(): HTMLElement {
  const vol = state.outputVolume;

  const label = h('span', { class: 'vfx-vol-pct' }, `${vol}%`);

  const slider = h('input', {
    type: 'range',
    class: 'vfx-volume-slider',
    id: 'vfx-volume-slider',
    min: '0',
    max: '200',
    step: '5',
    value: String(vol),
  }) as HTMLInputElement;

  on(slider, 'input', () => {
    const v = Number(slider.value);
    state.outputVolume = v;
    setOutputVolume(v);
    label.textContent = `${v}%`;
    // Color-code: green ≤100%, yellow ≤150%, red >150%
    slider.style.setProperty('--thumb-color',
      v <= 100 ? '#22C55E' : v <= 150 ? '#F4C430' : '#E53935'
    );
  });

  return h('div', { class: 'vfx-volume-row' },
    h('span', { class: 'vfx-row-label' }, '🔊 VOL'),
    slider,
    label
  );
}

/* ------------------------------------------------------------------- Modals */

function showQrModal(): void {
  const baseUrl = new URL(window.location.href);
  baseUrl.search = '';
  baseUrl.hash = '';
  baseUrl.searchParams.set('channel', state.channel);
  const relay = localStorage.getItem('cw_relay') || import.meta.env.VITE_RELAY_URL || '';
  if (relay) baseUrl.searchParams.set('relay', relay);

  const safeUrl = baseUrl.toString();

  const qrUrl = new URL(safeUrl);
  const pass = sessionStorage.getItem('cw_passphrase') || '';
  if (pass) {
    qrUrl.hash = `key=${encodeURIComponent(pass)}`;
  }

  const canvas = h('canvas', { class: 'qr-canvas' }) as HTMLCanvasElement;
  drawQr(canvas, qrUrl.toString(), '#121212', '#FFFFFF');

  const copyBtn = h('button', { class: 'btn btn-primary w-full' }, 'COPY SAFE LINK 🔒');
  on(copyBtn, 'click', () => {
    navigator.clipboard.writeText(safeUrl);
    copyBtn.textContent = 'SAFE LINK COPIED! ✔';
    setTimeout(() => { copyBtn.textContent = 'COPY SAFE LINK 🔒'; }, 2000);
  });

  showModal('INVITE FRIENDS', 'sticky-tape-green', [
    h('div', { class: 'qr-panel flex flex-col items-center gap-3 text-center' },
      canvas,
      h('div', { class: 'text-xs font-mono text-muted font-bold' }, '📷 QR Code: Quick Join (In-person scanning)'),
      h('div', { class: 'w-full border-t-2 border-black my-1' }),
      h('div', { class: 'text-xs text-muted text-left w-full font-mono font-bold' }, '🔒 Safe Share Link:'),
      h('input', { type: 'text', readonly: true, value: safeUrl, class: 'share-url-input w-full p-2 border border-black font-mono text-xs' }),
      copyBtn,
      h('p', { class: 'text-xs text-muted font-mono text-left' }, 'Recipients will be prompted for the secret passcode when opening the link.')
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
