/**
 * Join screen component (State 1).
 *
 * Brutalist + Engineering Notebook design with Split Desktop Layout:
 * LEFT: Brand, Logo, Tagline, Security Badges, Join Card (Channel, Passphrase, Display Name, Advanced, Join button).
 * RIGHT: Notebook illustration frame with live frequency preview.
 */

import { clear, h, on, svgEl } from './dom';
import { arrowDoodleSvg, radioTowerSvg } from './doodles';
import { createDoodleArea } from '../components/DoodleArea';

export interface JoinOptions {
  channel: string;
  passphrase: string;
  name: string;
  relay: string;
}

export function renderJoinScreen(
  container: HTMLElement,
  onJoin: (opts: JoinOptions) => void,
  isDeriving: boolean = false,
  kdfProgress: number = 0,
  errorMsg: string = '',
): void {
  const savedName = localStorage.getItem('cw_name') ?? '';
  const savedChannel = localStorage.getItem('cw_channel') ?? '';
  const savedRelay = localStorage.getItem('cw_relay') ?? import.meta.env.VITE_RELAY_URL ?? '';

  // Check URL params for channel invite link
  const urlParams = new URLSearchParams(window.location.search);
  const inviteChannel = urlParams.get('channel') ?? savedChannel;
  const inviteRelay = urlParams.get('relay') ?? savedRelay;

  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const hashParams = new URLSearchParams(rawHash);
  const inviteKey = hashParams.get('key') ?? urlParams.get('key') ?? '';

  clear(container);

  let showAdvanced = Boolean(urlParams.get('relay')) || inviteRelay !== (import.meta.env.VITE_RELAY_URL ?? '');
  let showPassword = false;

  const channelInput = h('input', {
    type: 'text',
    id: 'cw-channel',
    placeholder: 'e.g. library-study-group',
    value: inviteChannel,
    required: true,
    autocomplete: 'off',
    disabled: isDeriving,
  }) as HTMLInputElement;

  const passphraseInput = h('input', {
    type: 'password',
    id: 'cw-passphrase',
    placeholder: 'Enter secret passphrase',
    value: inviteKey,
    required: true,
    autocomplete: 'current-password',
    disabled: isDeriving,
  }) as HTMLInputElement;

  const eyeToggleBtn = h('button', {
    type: 'button',
    class: 'eye-toggle-btn',
    title: 'Show/Hide Passphrase',
  }, '👁️');

  on(eyeToggleBtn, 'click', () => {
    showPassword = !showPassword;
    passphraseInput.type = showPassword ? 'text' : 'password';
    eyeToggleBtn.textContent = showPassword ? '🙈' : '👁️';
  });

  const passwordWrapper = h('div', { class: 'password-field-wrapper' },
    passphraseInput,
    eyeToggleBtn
  );

  const nameInput = h('input', {
    type: 'text',
    id: 'cw-name',
    placeholder: 'e.g. Alex',
    value: savedName,
    required: true,
    maxLength: 24,
    autocomplete: 'nickname',
    disabled: isDeriving,
  }) as HTMLInputElement;

  const relayInput = h('input', {
    type: 'text',
    id: 'cw-relay',
    placeholder: 'wss://campus-walkie-relay.workers.dev',
    value: inviteRelay,
    autocomplete: 'off',
    disabled: isDeriving,
  }) as HTMLInputElement;

  const advancedContainer = h('div', {
    class: `join-advanced ${showAdvanced ? '' : 'hidden'}`,
  },
    h('div', { class: 'field' },
      h('div', { class: 'field-header' },
        h('label', { for: 'cw-relay' }, 'Custom Signalling Relay (Optional)'),
      ),
      relayInput,
      h('span', { class: 'text-xs text-muted' }, 'Leave default unless self-hosting your own relay.')
    )
  );

  const advancedToggleBtn = h('button', {
    type: 'button',
    class: 'join-advanced-toggle',
  }, showAdvanced ? '▲ ADVANCED (optional)' : '▼ ADVANCED (optional)');

  on(advancedToggleBtn, 'click', () => {
    showAdvanced = !showAdvanced;
    advancedContainer.classList.toggle('hidden', !showAdvanced);
    advancedToggleBtn.textContent = showAdvanced ? '▲ ADVANCED (optional)' : '▼ ADVANCED (optional)';
  });

  const submitBtn = h('button', {
    type: 'submit',
    class: 'btn btn-primary w-full',
    disabled: isDeriving,
  }, isDeriving ? [
    h('div', { class: 'spinner' }),
    h('span', {}, 'DERIVING KEY...')
  ] : [
    h('span', {}, 'JOIN CHANNEL →')
  ]);

  const form = h('form', { class: 'join-card' },
    // Channel Field
    h('div', { class: 'field' },
      h('div', { class: 'field-header' },
        h('label', { for: 'cw-channel' }, 'Channel Name'),
        h('span', { class: 'doodle-note text-xs' }, 'same for everyone')
      ),
      channelInput
    ),

    // Passphrase Field
    h('div', { class: 'field' },
      h('div', { class: 'field-header' },
        h('label', { for: 'cw-passphrase' }, 'Passphrase / Key'),
        h('span', { class: 'doodle-note text-xs' }, 'keep it secret')
      ),
      passwordWrapper
    ),

    // Display Name Field
    h('div', { class: 'field' },
      h('div', { class: 'field-header' },
        h('label', { for: 'cw-name' }, 'Display Name'),
        h('span', { class: 'doodle-note text-xs' }, 'choose any nickname')
      ),
      nameInput
    ),

    advancedToggleBtn,
    advancedContainer,

    errorMsg ? h('div', { class: 'join-error-badge' }, [
      h('span', {}, '✖'),
      h('span', {}, errorMsg)
    ]) : null,

    // KDF Progress Indicator
    isDeriving ? h('div', { class: 'join-kdf-container' },
      h('div', { class: 'join-kdf-header' },
        h('span', { class: 'font-mono text-xs font-bold' }, 'DERIVING KEY'),
        h('span', { class: 'font-mono text-xs' }, `${Math.round(kdfProgress)}%`)
      ),
      h('div', { class: 'progress-track' },
        h('div', { class: 'progress-bar', style: `width: ${Math.max(5, kdfProgress)}%` })
      ),
      h('span', { class: 'doodle-note text-xs mt-1' }, [
        svgEl(arrowDoodleSvg(20, 12, 'up-right')),
        'generating secure key...'
      ])
    ) : null,

    submitBtn,

    h('div', { class: 'join-tip' },
      h('span', {}, '💡'),
      h('span', {}, 'TIP: Share channel + passphrase securely with your friends.')
    )
  );

  on(form, 'submit', (ev) => {
    ev.preventDefault();
    const channel = channelInput.value.trim();
    const passphrase = passphraseInput.value;
    const name = nameInput.value.trim() || 'Anonymous';
    const relay = relayInput.value.trim();

    if (!channel || !passphrase) return;

    localStorage.setItem('cw_name', name);
    localStorage.setItem('cw_channel', channel);
    if (relay) localStorage.setItem('cw_relay', relay);

    onJoin({ channel, passphrase, name, relay });
  });

  /* Left Column — Brand & Form */
  const leftColumn = h('div', { class: 'join-left-column' },
    createDoodleArea('hero-top-left'),
    
    h('div', { class: 'brand-header-box' },
      h('div', { class: 'brand-logo' }, h('span', { dangerouslySetInnerHTML: { __html: '' } })),
      h('div', { class: 'brand-title-group' },
        h('h1', { class: 'brand-h1' }, 'CAMPUS WALKIE'),
        h('div', { class: 'brand-sub' }, 'PRIVATE CAMPUS RADIO')
      )
    ),

    h('div', { class: 'hero-statement-box' },
      h('h2', { class: 'hero-h2' }, 'PRIVATE VOICE. REAL CONVERSATIONS.'),
      h('p', { class: 'hero-tagline' }, 'Hold to talk. Nothing stored.')
    ),

    // Security Badges
    h('div', { class: 'security-badges-container' },
      h('div', { class: 'sec-badge' }, [h('span', { class: 'text-xs' }, '🔒'), 'Zero-Knowledge']),
      h('div', { class: 'sec-badge' }, [h('span', { class: 'text-xs' }, '🛡️'), 'End-to-End Encrypted']),
      h('div', { class: 'sec-badge' }, [h('span', { class: 'text-xs' }, '☁️'), 'No Server Storage']),
      h('div', { class: 'sec-badge' }, [h('span', { class: 'text-xs' }, '📡'), 'Works Offline']),
      h('div', { class: 'sec-badge' }, [h('span', { class: 'text-xs' }, '📱'), 'Cross Platform'])
    ),

    form,

    createDoodleArea('join-bottom-right')
  );

  /* Right Column — Notebook Preview Illustration */
  const towerEl = svgEl(radioTowerSvg(64, 64));

  const rightColumn = h('div', { class: 'join-right-column' },
    createDoodleArea('hero-top-right'),
    h('div', { class: 'notebook-frame-card' },
      h('div', { class: 'notebook-header-line' },
        h('span', { class: 'font-mono text-xs font-bold' }, 'RADIO FREQUENCY NOTEBOOK'),
        h('span', { class: 'sticky-tape sticky-tape-yellow' }, 'SIGNAL STANDBY')
      ),
      h('div', { class: 'flex flex-col items-center gap-4 py-8 text-center' },
        towerEl,
        h('span', { class: 'font-mono text-sm font-semibold' }, 'Channel frequency preview'),
        h('span', { class: 'doodle-note text-base' }, 'Enter channel details on the left to join')
      )
    )
  );

  const desktopWrapper = h('div', { class: 'join-desktop-wrapper' },
    leftColumn,
    rightColumn
  );

  container.append(desktopWrapper);
}
