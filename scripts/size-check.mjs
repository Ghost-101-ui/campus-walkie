import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const MAX_GZIP_JS_KB = 65;
const distDir = './dist';

try {
  const files = readdirSync(distDir, { recursive: true });
  let totalJsGzip = 0;

  console.log('\n📦 Build Size Report:\n');

  for (const f of files) {
    const p = join(distDir, String(f));
    const stat = statSync(p);
    if (!stat.isFile()) continue;

    const content = readFileSync(p);
    const gz = gzipSync(content).length;

    console.log(`  ${String(f).padEnd(35)} ${(stat.size / 1024).toFixed(2)} KB  (gzip: ${(gz / 1024).toFixed(2)} KB)`);

    if (String(f).endsWith('.js') && !String(f).includes('sw.js')) {
      totalJsGzip += gz;
    }
  }

  const jsGzipKb = totalJsGzip / 1024;
  console.log(`\n Total JS gzip size: ${jsGzipKb.toFixed(2)} KB (budget limit: ${MAX_GZIP_JS_KB} KB)`);

  if (jsGzipKb > MAX_GZIP_JS_KB) {
    console.error(`❌ Build exceeds JS budget limit! (${jsGzipKb.toFixed(2)} KB > ${MAX_GZIP_JS_KB} KB)`);
    process.exit(1);
  } else {
    console.log('✅ Bundle budget size check passed!');
  }
} catch (err) {
  console.warn('Size check skipped or failed to inspect build directory:', err.message);
}
