/**
 * KDF worker. Keeps 600 000 PBKDF2 iterations off the main thread.
 *
 * Protocol:
 *   in  { channelName, passphrase, iterations }
 *   out { t:'estimate', calibrationMs, estimateMs }   (once, before the real work)
 *   out { t:'ok', channelKey, channelId, iterations } | { t:'err', message }
 *
 * The passphrase exists in this worker's memory only for the duration of the
 * derivation and is never stored or logged.
 */

import { deriveChannelKeys, KDF_ITERATIONS } from './kdf';

const CALIBRATION_ITERATIONS = 5_000;

self.onmessage = async (ev: MessageEvent) => {
  const { channelName, passphrase, iterations } = ev.data as {
    channelName: string;
    passphrase: string;
    iterations?: number;
  };
  const iters = iterations ?? KDF_ITERATIONS;
  try {
    const t0 = performance.now();
    await deriveChannelKeys('calibration', 'calibration', CALIBRATION_ITERATIONS);
    const calibrationMs = performance.now() - t0;
    self.postMessage({
      t: 'estimate',
      calibrationMs,
      estimateMs: Math.max(150, (calibrationMs / CALIBRATION_ITERATIONS) * iters),
    });

    const keys = await deriveChannelKeys(channelName, passphrase, iters);
    self.postMessage({
      t: 'ok',
      channelKey: keys.channelKey,
      channelId: keys.channelId,
      iterations: keys.iterations,
    });
  } catch (err) {
    self.postMessage({ t: 'err', message: err instanceof Error ? err.message : 'kdf failed' });
  }
};
