/**
 * Hand-drawn engineering doodles and SVG icons for Campus Walkie design system.
 * Minimal single-stroke SVGs with hand-drawn aesthetic.
 */

export function radioTowerSvg(width = 64, height = 64): string {
  return `<svg width="${width}" height="${height}" viewBox="0 0 64 64" fill="none" stroke="#121212" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M32 8L20 56H44L32 8Z"/>
    <path d="M26 32H38"/>
    <path d="M23 44H41"/>
    <circle cx="32" cy="7" r="3" fill="#2962FF" stroke="#121212" stroke-width="2"/>
    <path d="M22 12C18 16 18 22 22 26" stroke="#121212" stroke-width="2"/>
    <path d="M42 12C46 16 46 22 42 26" stroke="#121212" stroke-width="2"/>
    <path d="M16 6C10 12 10 28 16 34" stroke="#2962FF" stroke-width="2" stroke-dasharray="3 3"/>
    <path d="M48 6C54 12 54 28 48 34" stroke="#2962FF" stroke-width="2" stroke-dasharray="3 3"/>
  </svg>`;
}

export function walkieTalkieSvg(width = 48, height = 48): string {
  return `<svg width="${width}" height="${height}" viewBox="0 0 48 48" fill="none" stroke="#121212" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="16" y1="4" x2="16" y2="16"/>
    <rect x="28" y="10" width="6" height="6" fill="#121212"/>
    <rect x="12" y="16" width="24" height="28" rx="2" fill="#FFFFFF"/>
    <rect x="16" y="20" width="16" height="8" fill="#F8F8F4"/>
    <line x1="18" y1="24" x2="28" y2="24" stroke="#2962FF"/>
    <line x1="18" y1="32" x2="30" y2="32"/>
    <line x1="18" y1="35" x2="30" y2="35"/>
    <line x1="18" y1="38" x2="30" y2="38"/>
    <rect x="8" y="22" width="4" height="10" fill="#2962FF"/>
  </svg>`;
}

export function lockKeySvg(width = 48, height = 48): string {
  return `<svg width="${width}" height="${height}" viewBox="0 0 48 48" fill="none" stroke="#121212" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="20" width="20" height="20" rx="2" fill="#FFFFFF"/>
    <path d="M12 20V14C12 10.7 14.7 8 18 8C21.3 8 24 10.7 24 14V20"/>
    <circle cx="18" cy="30" r="2" fill="#121212"/>
    <circle cx="36" cy="18" r="5" fill="#FFFFFF"/>
    <line x1="36" y1="23" x2="36" y2="38"/>
    <line x1="36" y1="30" x2="40" y2="30"/>
    <line x1="36" y1="34" x2="40" y2="34"/>
  </svg>`;
}

export function satelliteDishSvg(width = 64, height = 64): string {
  return `<svg width="${width}" height="${height}" viewBox="0 0 64 64" fill="none" stroke="#121212" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M32 40L24 56"/>
    <path d="M32 40L40 56"/>
    <line x1="18" y1="56" x2="46" y2="56"/>
    <path d="M14 26C18 36 34 40 44 32C52 26 50 14 38 12C26 10 16 18 14 26Z" fill="#FFFFFF"/>
    <line x1="32" y1="22" x2="46" y2="12"/>
    <circle cx="46" cy="12" r="3" fill="#2962FF"/>
    <path d="M50 8C54 6 58 8 60 12" stroke="#2962FF"/>
    <path d="M48 4C56 2 62 6 64 12" stroke="#2962FF" stroke-dasharray="2 2"/>
  </svg>`;
}

export function micIconSvg(width = 24, height = 24, stroke = "#121212"): string {
  return `<svg width="${width}" height="${height}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="11" rx="3"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
    <line x1="8" y1="22" x2="16" y2="22"/>
  </svg>`;
}

export function arrowDoodleSvg(
  width = 32,
  height = 18,
  direction: 'down-right' | 'up-right' | 'down-left' | 'curve-left' = 'down-right'
): string {
  if (direction === 'curve-left') {
    return `<svg width="${width}" height="${height}" viewBox="0 0 32 18" fill="none" stroke="#121212" stroke-width="1.5" stroke-linecap="round">
      <path d="M28 2C20 12 10 14 4 12"/>
      <path d="M8 8L3 12L7 16"/>
    </svg>`;
  }
  if (direction === 'up-right') {
    return `<svg width="${width}" height="${height}" viewBox="0 0 32 18" fill="none" stroke="#121212" stroke-width="1.5" stroke-linecap="round">
      <path d="M4 16C12 12 20 6 28 4"/>
      <path d="M22 2L29 4L26 10"/>
    </svg>`;
  }
  if (direction === 'down-left') {
    return `<svg width="${width}" height="${height}" viewBox="0 0 32 18" fill="none" stroke="#121212" stroke-width="1.5" stroke-linecap="round">
      <path d="M28 2C20 4 12 10 4 14"/>
      <path d="M10 16L3 14L6 8"/>
    </svg>`;
  }
  return `<svg width="${width}" height="${height}" viewBox="0 0 32 18" fill="none" stroke="#121212" stroke-width="1.5" stroke-linecap="round">
    <path d="M4 2C12 4 20 10 28 14"/>
    <path d="M22 16L29 14L26 8"/>
  </svg>`;
}
