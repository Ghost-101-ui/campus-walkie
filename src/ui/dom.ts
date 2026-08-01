/** The whole "framework": create elements, find them, listen to them. */

type Child = Node | string | number | false | null | undefined | Child[];

/** Create an element. `props` sets properties, `data-*`/`aria-*` become attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role' || key === 'for') {
      el.setAttribute(key, String(value));
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'style' && typeof value === 'string') {
      el.setAttribute('style', value);
    } else {
      (el as unknown as Record<string, unknown>)[key] = value;
    }
  }
  append(el, children);
  return el;
}

/** Append children recursively, skipping false/null/undefined. */
export function append(parent: Element, children: Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else {
      parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
}

/** Safely render raw SVG string as an inline HTML Element */
export function svgEl(svgString: string, className = ''): HTMLElement {
  const wrapper = document.createElement('span');
  if (className) wrapper.className = className;
  wrapper.innerHTML = svgString;
  return wrapper;
}

export function $<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function on<T extends EventTarget, E extends Event = Event>(
  target: T,
  type: string,
  handler: (ev: E) => void,
  options?: AddEventListenerOptions,
): () => void {
  const fn = handler as EventListener;
  target.addEventListener(type, fn, options);
  return () => target.removeEventListener(type, fn, options);
}

/** `hh:mm` in the user's locale, for message timestamps. */
export function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Resolves an icon URL handling base paths for Vite */
export const icon = (name: string) => `${import.meta.env.BASE_URL}icons/${name}`;
