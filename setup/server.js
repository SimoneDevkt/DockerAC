// First-run setup page. Listens on the Server Manager port (8772) until the
// installation is complete, then exits so the entrypoint can start Server Manager.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, TMP_DIR, ASSETTO_DIR, FREE_SM_URL, UPLOAD_KINDS,
  exists, install, listUploads, saveUploadMeta, deleteUpload, uploadPath, readMarker,
  sendInput, cancelRunning,
} from './installer.js';

const PORT = parseInt(process.env.SETUP_PORT || '8772', 10);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PASSWORD = process.env.SETUP_PASSWORD || crypto.randomBytes(9).toString('base64url');

const sessions = new Set();
let failedLogins = 0;
let installing = false;
let finished = false;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)acsetup=([A-Za-z0-9_-]+)/);
  return Boolean(m && sessions.has(m[1]));
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleUpload(req, res, kind, name) {
  const spec = UPLOAD_KINDS[kind];
  if (!spec) return send(res, 404, { error: 'unknown upload type' });
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > spec.maxBytes) return send(res, 413, { error: 'file too large' });

  await fs.mkdir(TMP_DIR, { recursive: true });
  await deleteUpload(kind);
  const target = uploadPath(kind);
  const out = createWriteStream(target);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > spec.maxBytes) throw new Error('file too large');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await deleteUpload(kind);
    return send(res, 400, { error: err.message });
  }
  if (size === 0) {
    await deleteUpload(kind);
    return send(res, 400, { error: 'empty file' });
  }
  const meta = { name: String(name || kind).slice(0, 200), size, at: new Date().toISOString() };
  await saveUploadMeta(kind, meta);
  console.log(`[setup] upload ${kind}: ${meta.name} (${size} bytes)`);
  return send(res, 200, meta);
}

async function handleInstall(req, res) {
  if (installing) return send(res, 409, { error: 'installation already running' });
  let opts;
  try { opts = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }); }

  installing = true;
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const log = (line) => {
    console.log(`[setup] ${line}`);
    res.write(`${line}\n`);
  };
  try {
    await install(opts, log);
    res.end('@@DONE\n');
    finish();
  } catch (err) {
    console.error('[setup] installation failed:', err);
    res.end(`@@ERROR ${err.message}\n`);
  } finally {
    installing = false;
  }
}

function finish() {
  if (finished) return;
  finished = true;
  console.log('[setup] setup completed, handing over to Server Manager');
  setTimeout(() => {
    server.close();
    server.closeAllConnections?.();
    process.exit(0);
  }, 1000);
}

async function route(req, res) {
  res.setHeader('X-AC-Setup', '1');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && STATIC[pathname]) {
    const [file, type] = STATIC[pathname];
    return send(res, 200, await fs.readFile(path.join(PUBLIC_DIR, file)), type);
  }
  if (req.method === 'GET' && pathname === '/healthcheck.json') {
    return send(res, 200, { setup: true });
  }
  if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // custom header: cross-site forms cannot set it without a CORS preflight
  if (req.method !== 'GET' && req.headers['x-acsetup'] !== '1') {
    return send(res, 403, { error: 'invalid request' });
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req).catch(() => ({}));
    if (failedLogins > 20) await new Promise((r) => setTimeout(r, 3000));
    if (!safeEqual(body.password || '', PASSWORD)) {
      failedLogins++;
      await new Promise((r) => setTimeout(r, 750));
      return send(res, 401, { error: 'wrong password' });
    }
    const id = crypto.randomBytes(24).toString('base64url');
    sessions.add(id);
    res.setHeader('Set-Cookie', `acsetup=${id}; HttpOnly; SameSite=Strict; Path=/`);
    return send(res, 200, { ok: true });
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'login required' });

  if (req.method === 'GET' && pathname === '/api/state') {
    const serversYml = await fs.readFile(path.join(DATA_DIR, 'servers.yml'), 'utf8').catch(() => '');
    const servers = parseInt(serversYml.match(/^servers:\s*(\d+)/m)?.[1] || '', 10) || null;
    return send(res, 200, {
      servers,
      installed: await readMarker(),
      uploads: await listUploads(),
      hasAcServer: await exists(path.join(ASSETTO_DIR, 'acServer')),
      hasLicense: await exists(path.join(DATA_DIR, 'ACSM.License')),
      hasConfig: await exists(path.join(DATA_DIR, 'config.yml')),
      freeUrl: FREE_SM_URL,
      installing,
    });
  }

  const up = pathname.match(/^\/api\/upload\/([a-z]+)$/);
  if (up && req.method === 'PUT') {
    if (installing) return send(res, 409, { error: 'installation running' });
    return handleUpload(req, res, up[1], url.searchParams.get('name'));
  }
  if (up && req.method === 'DELETE') {
    if (!UPLOAD_KINDS[up[1]]) return send(res, 404, { error: 'unknown upload type' });
    await deleteUpload(up[1]);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/install') return handleInstall(req, res);

  // input for the running command (e.g. the Steam Guard code asked by steamcmd)
  if (req.method === 'POST' && pathname === '/api/input') {
    const body = await readJson(req).catch(() => ({}));
    const value = String(body.value || '').trim();
    if (!value || value.length > 64 || /[\r\n]/.test(value)) return send(res, 400, { error: 'invalid value' });
    if (!sendInput(value)) return send(res, 409, { error: 'nothing is waiting for input' });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/cancel') {
    if (!cancelRunning()) return send(res, 409, { error: 'nothing to cancel right now' });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/skip') {
    if (!(await readMarker())) return send(res, 400, { error: 'no existing installation' });
    await fs.rm(path.join(DATA_DIR, '.reconfigure'), { force: true });
    send(res, 200, { ok: true });
    return finish();
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[setup] request error:', err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  });
});
server.requestTimeout = 0; // large uploads

server.listen(PORT, '0.0.0.0', () => {
  const bar = '='.repeat(64);
  console.log(bar);
  console.log(' DockerAC setup: open http://<host>:%d in your browser', PORT);
  if (process.env.SETUP_PASSWORD) console.log(' password: the one set in SETUP_PASSWORD');
  else console.log(` setup password: ${PASSWORD}`);
  console.log(bar);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => process.exit(130));
}
