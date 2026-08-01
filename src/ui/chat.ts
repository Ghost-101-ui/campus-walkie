/**
 * Chat component.
 *
 * Minimal Linear / Slack style timeline view.
 * Highlights own messages with a blue left border (`border-l-4 border-[#2962FF]`). No speech bubbles!
 */

import { clear, h, hhmm, icon, on } from './dom';
import type { Message } from '../types';

export interface ChatHandlers {
  onSendText(text: string): void;
  onSendFile(file: File): void;
}

export function renderChatArea(
  container: HTMLElement,
  messages: Message[],
  handlers: ChatHandlers
): void {
  clear(container);

  const messagesList = h('div', { class: 'chat-timeline', id: 'chat-messages' });

  for (const m of messages) {
    messagesList.append(renderTimelineMessage(m));
  }

  const textInput = h('textarea', {
    placeholder: 'Type a message...',
    rows: '1',
    id: 'chat-input',
    class: 'chat-input-brutal'
  }) as HTMLTextAreaElement;

  const fileInput = h('input', {
    type: 'file',
    id: 'file-picker',
    style: 'display: none;',
  }) as HTMLInputElement;

  const attachBtn = h('button', {
    type: 'button',
    class: 'composer-btn-brutal',
    title: 'Attach File',
  }, h('img', { class: 'control-icon', src: icon('addfile.gif'), alt: 'Attach file' }));

  const sendBtn = h('button', {
    type: 'button',
    class: 'composer-btn-brutal send-btn-accent',
    title: 'Send Message',
  }, '➤');

  on(attachBtn, 'click', () => fileInput.click());

  on(fileInput, 'change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      handlers.onSendFile(file);
      fileInput.value = '';
    }
  });

  const triggerSend = () => {
    const text = textInput.value.trim();
    if (!text) return;
    handlers.onSendText(text);
    textInput.value = '';
    textInput.style.height = 'auto';
  };

  on(sendBtn, 'click', triggerSend);

  on(textInput, 'keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      triggerSend();
    }
  });

  on(textInput, 'input', () => {
    textInput.style.height = 'auto';
    textInput.style.height = `${Math.min(120, textInput.scrollHeight)}px`;
  });

  const composer = h('div', { class: 'composer-brutal' },
    attachBtn,
    fileInput,
    textInput,
    sendBtn
  );

  container.append(messagesList, composer);

  // Auto-scroll to bottom
  requestAnimationFrame(() => {
    messagesList.scrollTop = messagesList.scrollHeight;
  });
}

function renderTimelineMessage(m: Message): HTMLElement {
  if (m.kind === 'system') {
    return h('div', { class: 'msg-system' },
      h('span', {}, '•'),
      h('span', {}, m.body)
    );
  }

  const isMine = m.mine;

  let bodyContent: HTMLElement | string;

  if (m.kind === 'text') {
    bodyContent = m.body;
  } else if (m.kind === 'file') {
    bodyContent = h('div', { class: 'msg-file-brutal font-mono text-xs' },
      h('span', {}, m.body),
      m.url ? h('a', {
        href: m.url,
        download: m.body,
        class: 'btn btn-ghost text-xs ml-2',
      }, '💾 Download File') : null
    );
  } else if (m.kind === 'voice') {
    bodyContent = h('div', { class: 'msg-voice-brutal font-mono text-xs' },
      h('span', {}, `🎙️ Voice Note (${m.body})`),
      m.url ? h('audio', {
        src: m.url,
        controls: true,
        style: 'max-width: 200px; height: 28px;',
      }) : null
    );
  } else {
    bodyContent = m.body;
  }

  const metaLine = h('div', { class: 'msg-meta-line' },
    h('span', { class: 'msg-sender' }, isMine ? `${m.fromName} (YOU)` : m.fromName),
    h('span', { class: 'msg-time' }, hhmm(m.ts))
  );

  return h('div', { class: `msg-item-linear ${isMine ? 'mine' : ''}` },
    metaLine,
    h('div', { class: 'msg-body-txt' }, bodyContent)
  );
}
