import { webcrypto } from 'node:crypto';

// jsdom ships `crypto.getRandomValues` but no `crypto.subtle`. Swap in Node's
// standards-compliant WebCrypto so the exact same code paths run in tests.
if (!globalThis.crypto || !('subtle' in globalThis.crypto)) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
