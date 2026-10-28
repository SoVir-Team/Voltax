// Runs after `next build` (static export in out/):
// 1. Prefetch files: Next.js writes `<route>/__next.<segment>/__PAGE__.txt` but the browser requests
//    `<route>/__next.<segment>.__PAGE__.txt`. Hosting platforms map one to the other; the hub's plain
//    static file server does not, so write a copy under the requested name.
// 2. Service worker: write out/sw.js with every exported file precached and a cache name derived
//    from the build's content, so installed apps update exactly when the UI changes.
import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'out');

const listFiles = () =>
  readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(out, join(d.parentPath, d.name)).split(sep).join('/'))
    .sort();

// 1. flatten segment prefetch paths
let flattened = 0;
for (const file of listFiles()) {
  const m = /^(.*?)(__next\.[^/]+)\/(.+\.txt)$/.exec(file);
  if (!m) continue;
  copyFileSync(join(out, file), join(out, `${m[1]}${m[2]}.${m[3].replaceAll('/', '.')}`));
  flattened++;
}

// 2. service worker
const files = listFiles().filter((f) => f !== 'sw.js');
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(join(out, f)));

// Pages are requested as /schedules/, not /schedules/index.html.
const urls = files.map((f) => '/' + f.replace(/(^|\/)index\.html$/, '$1'));

const sw = readFileSync(join(root, 'scripts', 'sw.template.js'), 'utf8')
  .replace('__CACHE__', `voltex-${hash.digest('hex').slice(0, 12)}`)
  .replace('[/* __SHELL__ */]', JSON.stringify(urls, null, 2));
writeFileSync(join(out, 'sw.js'), sw);
console.log(`postbuild: ${flattened} prefetch files mapped, sw.js precaches ${urls.length} files`);
