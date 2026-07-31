/**
 * Reusable DoodleArea component.
 * Renders placeholder regions and decorative doodle annotations.
 */
import { doodleConfig } from '../config/doodles';
import { h, svgEl } from '../ui/dom';
import { arrowDoodleSvg } from '../ui/doodles';

export type DoodleAreaId =
  | 'hero-top-left'
  | 'hero-top-right'
  | 'join-bottom-right'
  | 'chat-top-right'
  | 'chat-bottom-left'
  | 'footer-note'
  | 'ptt-bottom';

export function createDoodleArea(id: DoodleAreaId, customClass = ''): HTMLElement {
  const container = h('div', {
    class: `doodle-area doodle-area-${id} ${customClass}`,
    'data-doodle-id': id,
  });

  if (!doodleConfig.enabled) {
    return container;
  }

  let content: HTMLElement | (HTMLElement | string)[] | null = null;

  switch (id) {
    case 'hero-top-left':
      content = [
        h('span', { class: 'doodle-note font-caveat text-base' }, 'private by design'),
        svgEl(arrowDoodleSvg(24, 14, 'down-right'), 'doodle-svg'),
      ];
      break;
    case 'hero-top-right':
      content = [
        h('span', { class: 'doodle-note font-caveat text-base' }, 'voice first'),
        svgEl(arrowDoodleSvg(20, 12, 'down-left'), 'doodle-svg'),
      ];
      break;
    case 'join-bottom-right':
      content = h('div', { class: 'doodle-note-box' }, [
        h('span', { class: 'font-caveat text-sm block leading-tight' }, 'No sign-up.\nNo tracking.\nJust talk.'),
      ]);
      break;
    case 'chat-top-right':
      content = [
        h('span', { class: 'doodle-note font-caveat text-xs' }, 'live signal'),
        svgEl(arrowDoodleSvg(18, 12, 'down-left'), 'doodle-svg'),
      ];
      break;
    case 'chat-bottom-left':
      content = [
        h('span', { class: 'doodle-note font-caveat text-xs' }, 'invite your friends'),
        svgEl(arrowDoodleSvg(22, 14, 'curve-left'), 'doodle-svg'),
      ];
      break;
    case 'footer-note':
      content = h('span', { class: 'doodle-note font-caveat text-xs' }, 'Built for campus. Built for privacy.');
      break;
    case 'ptt-bottom':
      content = [
        h('span', { class: 'doodle-note font-caveat text-xs' }, 'hold to talk'),
        svgEl(arrowDoodleSvg(16, 10, 'curve-left'), 'doodle-svg mx-1'),
        h('span', { class: 'doodle-note font-caveat text-xs' }, 'release to listen'),
      ];
      break;
  }

  if (content) {
    if (Array.isArray(content)) {
      container.append(...content);
    } else {
      container.append(content);
    }
  }

  return container;
}
