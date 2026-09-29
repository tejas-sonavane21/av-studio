/**
 * tools/serve.mjs — the smallest possible static server for local development.
 *
 * ES modules, Web Workers and (later) `canvas.captureStream` all require an http(s) origin,
 * so the app can never be opened from `file://`. This replaces `python -m http.server`,
 * which is not installed on every Windows dev box, without adding a dependency.
 *
 *   node tools/serve.mjs [port] [root]
 *
 * `root` defaults to this project folder and is resolved relative to it. It exists for one caller:
 * the visual parity harness (`tests/visual/parity.html`), which has to read the reference media in
 * `../referece_material/`. Everything else should just serve the project folder.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentRange, parseRange } from './range.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8000);
const ROOT = process.argv[3] ? resolve(PROJECT_ROOT, process.argv[3]) : PROJECT_ROOT;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

/**
 * Turn a request target into a decoded, root-relative path.
 * Returns `null` for anything that is not a well-formed origin-form target.
 */
function decodePath (requestTarget) {
  const raw = String(requestTarget ?? '/').split('?')[0].split('#')[0];
  if (!raw.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // malformed escape, e.g. '/%zz'
  }
  return decoded.includes('\0') ? null : decoded;
}

const server = createServer((req, res) => {
  // Parse the request target by hand. `new URL(req.url, ...)` looks convenient but it treats a
  // target starting with `//` as protocol-relative and throws ERR_INVALID_URL, and it throws on
  // malformed percent-encoding — either one would take the whole dev server down.
  const urlPath = decodePath(req.url);
  if (urlPath === null) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad Request');
    return;
  }
  let target = normalize(join(ROOT, urlPath));
  // never serve anything outside the project folder ('..', '%2e%2e' and '%5c' all land here)
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
    return;
  }
  let size;
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    size = statSync(target).size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`404 ${urlPath}`);
    return;
  }

  const headers = {
    'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };

  // Byte ranges. Not optional for this project: `<video>` seeking in Chrome relies on 206 responses,
  // so without this the preview (and the visual parity harness) cannot scrub.
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': contentRange(range, size),
      'content-length': String(range.end - range.start + 1),
    });
    createReadStream(target, range).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': String(size) });
  createReadStream(target).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Caption Studio → http://localhost:${PORT}`);
  console.log(`serving ${ROOT}`);
});
