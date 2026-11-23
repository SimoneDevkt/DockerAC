// Installation steps run by the setup page. Everything is written inside DATA_DIR
// (the container volume), so nothing is lost when the image is updated.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DATA_DIR = process.env.DATA_DIR || '/data';
export const TMP_DIR = path.join(DATA_DIR, '.setup-tmp');
export const MARKER = path.join(DATA_DIR, '.installed');
export const RECONFIGURE = path.join(DATA_DIR, '.reconfigure');
export const ASSETTO_DIR = path.join(DATA_DIR, 'assetto');

export const FREE_SM_URL = process.env.FREE_SM_URL ||
  'https://github.com/JustaPenguin/assetto-server-manager/releases/download/v1.7.9/server-manager_v1.7.9.zip';
export const STEAMCMD_URL = process.env.STEAMCMD_URL ||
  'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';
const AC_SERVER_APP_ID = '302550';

// Upload kinds accepted by the setup page.
export const UPLOAD_KINDS = {
  acsm: { label: 'Assetto Corsa Server Manager (zip)', maxBytes: 1024 ** 3 },
  license: { label: 'ACSM.License', maxBytes: 1024 ** 2 },
  assetto: { label: 'Assetto Corsa dedicated server (zip)', maxBytes: 8 * 1024 ** 3 },
  stracker: { label: 'sTracker', maxBytes: 1024 ** 3 },
  realpenalty: { label: 'Real Penalty', maxBytes: 1024 ** 3 },
  kissmyrank: { label: 'KissMyRank', maxBytes: 1024 ** 3 },
};

export const PLUGINS = {
  // marker: a file whose parent directory is the plugin root
  stracker: { markers: ['stracker_linux_x86.tgz', 'stracker-default.ini', 'stracker.exe'] },
  realpenalty: { markers: ['ac_penalty', 'ac_penalty.exe'] },
  kissmyrank: { markers: ['ac_kissmyrank-linux'] },
};

export const uploadPath = (kind) => path.join(TMP_DIR, `${kind}.bin`);
const uploadMetaPath = (kind) => path.join(TMP_DIR, `${kind}.json`);

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function listUploads() {
  const out = {};
  for (const kind of Object.keys(UPLOAD_KINDS)) {
    try {
      out[kind] = JSON.parse(await fs.readFile(uploadMetaPath(kind), 'utf8'));
    } catch { /* not uploaded */ }
  }
  return out;
}

export async function saveUploadMeta(kind, meta) {
  await fs.writeFile(uploadMetaPath(kind), JSON.stringify(meta));
}

export async function deleteUpload(kind) {
  await fs.rm(uploadPath(kind), { force: true });
  await fs.rm(uploadMetaPath(kind), { force: true });
}

export async function readMarker() {
  try {
    const text = await fs.readFile(MARKER, 'utf8');
    const info = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) info[m[1]] = m[2];
    }
    return info;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// helpers

function run(log, cmd, args, { cwd, mask = [], allowFail = false } = {}) {
  const shown = args.map((a) => (mask.includes(a) ? '******' : a)).join(' ');
  log(`$ ${path.basename(cmd)} ${shown}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => {
      let text = buf.toString();
      for (const secret of mask) if (secret && secret.length >= 3) text = text.split(secret).join('******');
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(`  ${line}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFail) resolve(code);
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

async function detectArchive(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { buffer } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) return 'tgz';
    return null;
  } finally {
    await fh.close();
  }
}

async function extract(log, archive, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const type = await detectArchive(archive);
  if (type === 'zip') await run(log, 'unzip', ['-q', '-o', archive, '-d', dest]);
  else if (type === 'tgz') await run(log, 'tar', ['-xzf', archive, '-C', dest]);
  else throw new Error('unrecognised archive format (.zip and .tar.gz are supported)');
}

// Breadth-first search for a file by name, returns its full path.
async function findFile(root, names, maxDepth = 5) {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && names.includes(e.name)) return path.join(dir, e.name);
      }
      for (const e of entries) {
        if (e.isDirectory() && e.name !== '__MACOSX') next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return null;
}

// Strip wrapper folders: while a directory contains exactly one sub directory
// and nothing else, descend into it.
async function stripWrappers(dir) {
  for (;;) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.name !== '__MACOSX');
    if (entries.length === 1 && entries[0].isDirectory()) dir = path.join(dir, entries[0].name);
    else return dir;
  }
}

async function copyMerge(log, src, dest) {
  await fs.mkdir(dest, { recursive: true });
  await run(log, 'cp', ['-a', `${src}/.`, `${dest}/`]);
}

async function chmodX(file) {
  if (!(await exists(file))) return;
  try {
    await fs.chmod(file, 0o755);
  } catch (err) {
    // not our file (e.g. copied in by root): fine as long as it is already executable
    try { await fs.access(file, fs.constants.X_OK); } catch {
      throw new Error(`${file} is not executable and is not owned by the container user (check PUID/PGID): ${err.code}`);
    }
  }
}

async function download(log, url, dest) {
  log(`Download ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await fs.stat(dest);
  log(`  downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
}

function patchConfig(text, { baseUrl }) {
  const key = crypto.randomBytes(32).toString('hex');
  text = text.replace(/^(\s*session_key:)\s*RANDOMLY_GENERATE_THIS\s*$/m, `$1 ${key}`);
  // sample credentials shipped in the default config: steam is handled by the setup page instead
  text = text.replace(/^(\s*username:)\s*foobar\s*$/m, '$1');
  text = text.replace(/^(\s*password:)\s*hunter2\s*$/m, '$1');
  text = text.replace(/^(\s*dont_open_browser:)\s*false\s*$/m, '$1 true');
  if (baseUrl) text = text.replace(/^(\s*server_manager_base_URL:).*$/m, `$1 ${baseUrl}`);
  return text;
}

async function installConfig(log, sourceConfig, opts) {
  const target = path.join(DATA_DIR, 'config.yml');
  const original = await fs.readFile(sourceConfig, 'utf8');
  await fs.writeFile(path.join(DATA_DIR, 'config.example.yml'), original);
  if (await exists(target)) {
    log('existing config.yml kept (the default one is in config.example.yml)');
    return;
  }
  await fs.writeFile(target, patchConfig(original, opts));
  log('config.yml created with a random session_key');
}

async function installLuaPlugins(log, root) {
  const src = path.join(root, 'plugins');
  const dest = path.join(DATA_DIR, 'plugins');
  if (!(await exists(src))) return;
  if (await exists(dest)) {
    log('existing plugins (lua) folder kept');
    return;
  }
  await copyMerge(log, src, dest);
}

// ---------------------------------------------------------------------------
// steps

async function installAcsm(log, opts, uploads) {
  const binary = path.join(DATA_DIR, 'server-manager');
  if (uploads.acsm) {
    log('== Installing Assetto Corsa Server Manager');
    const ex = path.join(TMP_DIR, 'x-acsm');
    await extract(log, uploadPath('acsm'), ex);
    const sm = await findFile(ex, ['server-manager']);
    if (!sm) throw new Error("the uploaded zip doesn't contain the 'server-manager' binary (the linux-amd64 build is required)");
    const root = path.dirname(sm);
    await fs.copyFile(sm, binary);
    await chmodX(binary);
    const multi = path.join(root, 'assetto-multiserver-manager');
    if (await exists(multi)) {
      await fs.copyFile(multi, path.join(DATA_DIR, 'assetto-multiserver-manager'));
      await chmodX(path.join(DATA_DIR, 'assetto-multiserver-manager'));
    }
    const conf = path.join(root, 'config.yml');
    if (await exists(conf)) await installConfig(log, conf, opts);
    await installLuaPlugins(log, root);
    const changelog = path.join(root, 'CHANGELOG.txt');
    if (await exists(changelog)) {
      const head = (await fs.readFile(changelog, 'utf8')).split('\n').find((l) => l.trim());
      if (head) log(`version: ${head.trim()}`);
    }
  } else {
    const previous = await readMarker();
    if (previous?.VARIANT !== 'acsm' || !(await exists(binary))) {
      throw new Error('upload the Assetto Corsa Server Manager zip (acsm_vX.Y.Z_linux-amd64.zip)');
    }
    log('== Server Manager already installed, binaries kept');
  }

  const license = path.join(DATA_DIR, 'ACSM.License');
  if (uploads.license) {
    await fs.copyFile(uploadPath('license'), license);
    log('ACSM.License installed');
  } else if (!(await exists(license))) {
    throw new Error('upload the ACSM.License file');
  }

  if (opts.mode === 'multi') {
    if (!(await exists(path.join(DATA_DIR, 'assetto-multiserver-manager')))) {
      throw new Error("the zip doesn't contain 'assetto-multiserver-manager', choose single server mode");
    }
    const servers = Math.max(1, Math.min(50, parseInt(opts.servers, 10) || 1));
    await fs.writeFile(
      path.join(DATA_DIR, 'servers.yml'),
      '# servers.yml - multiserver configuration for server manager\n\n' +
        '# change this number to the number of servers you would like to be set up for you.\n' +
        `servers: ${servers}\n`,
    );
    await fs.mkdir(path.join(DATA_DIR, 'servers'), { recursive: true });
    await fs.mkdir(path.join(DATA_DIR, 'shared_store.json'), { recursive: true });
    log(`servers.yml set to ${servers} server(s)`);
  }
}

async function installFree(log, opts) {
  log('== Installing the free Assetto Server Manager (JustaPenguin)');
  const zip = path.join(TMP_DIR, 'free.zip');
  await download(log, FREE_SM_URL, zip);
  const ex = path.join(TMP_DIR, 'x-free');
  await extract(log, zip, ex);
  const linuxDir = await findFile(ex, ['server-manager']);
  if (!linuxDir) throw new Error("the downloaded archive doesn't contain the linux 'server-manager'");
  const binary = path.join(DATA_DIR, 'server-manager');
  await fs.copyFile(linuxDir, binary);
  await chmodX(binary);
  const conf = path.join(path.dirname(linuxDir), 'config.yml');
  if (await exists(conf)) await installConfig(log, conf, opts);
  await installLuaPlugins(log, await stripWrappers(ex));
}

async function installAcServer(log, opts, uploads) {
  await fs.mkdir(ASSETTO_DIR, { recursive: true });
  const acServer = path.join(ASSETTO_DIR, 'acServer');

  switch (opts.acServer) {
    case 'builtin':
      if (opts.variant !== 'acsm') throw new Error('the built-in server is only available with the paid ACSM');
      log('== AC server: built into ACSM (Server Manager creates a barebones install)');
      return;

    case 'existing':
      if (!(await exists(acServer))) throw new Error(`acServer not found in ${ASSETTO_DIR}`);
      log('== AC server: using the existing assetto folder');
      await chmodX(acServer);
      return;

    case 'upload': {
      if (!uploads.assetto) throw new Error('upload the zip of the dedicated server folder');
      log('== AC server: installing from the uploaded zip');
      const ex = path.join(TMP_DIR, 'x-assetto');
      await extract(log, uploadPath('assetto'), ex);
      const found = await findFile(ex, ['acServer', 'acServer.exe']);
      const root = found ? path.dirname(found) : await stripWrappers(ex);
      await copyMerge(log, root, ASSETTO_DIR);
      await chmodX(acServer);
      return;
    }

    case 'steam': {
      const { user, pass, guard } = opts.steam || {};
      if (!user || !pass) throw new Error('enter your Steam username and password');
      log('== AC server: installing with steamcmd');
      const steamDir = path.join(DATA_DIR, 'steamcmd');
      const steamSh = path.join(steamDir, 'steamcmd.sh');
      if (!(await exists(steamSh))) {
        await fs.mkdir(steamDir, { recursive: true });
        const tgz = path.join(TMP_DIR, 'steamcmd.tar.gz');
        await download(log, STEAMCMD_URL, tgz);
        await run(log, 'tar', ['-xzf', tgz, '-C', steamDir]);
      }
      // first run self-updates steamcmd and may exit with a non-zero code
      await run(log, steamSh, ['+quit'], { cwd: steamDir, allowFail: true });
      const login = ['+login', user, pass];
      if (guard) login.push(guard);
      await run(log, steamSh, [
        '+@sSteamCmdForcePlatformType', 'windows',
        '+force_install_dir', ASSETTO_DIR,
        ...login,
        '+app_update', AC_SERVER_APP_ID, 'validate',
        '+quit',
      ], { cwd: steamDir, mask: [pass, guard].filter(Boolean), allowFail: true });
      if (!(await exists(acServer))) {
        throw new Error('steamcmd did not install acServer: check credentials and Steam Guard in the log');
      }
      await chmodX(acServer);
      log('acServer installed');
      return;
    }

    default:
      throw new Error('choose how to install the Assetto Corsa server');
  }
}

async function installPlugin(log, kind) {
  log(`== Plugin ${UPLOAD_KINDS[kind].label}`);
  const ex = path.join(TMP_DIR, `x-${kind}`);
  await extract(log, uploadPath(kind), ex);
  const marker = await findFile(ex, PLUGINS[kind].markers);
  const root = marker ? path.dirname(marker) : await stripWrappers(ex);
  const dest = path.join(ASSETTO_DIR, kind);
  await copyMerge(log, root, dest);

  if (kind === 'stracker') {
    const tgz = path.join(dest, 'stracker_linux_x86.tgz');
    if (await exists(tgz)) await run(log, 'tar', ['-xzf', tgz, '-C', dest]);
    await chmodX(path.join(dest, 'stracker_linux_x86', 'stracker'));
  } else if (kind === 'kissmyrank') {
    await chmodX(path.join(dest, 'ac_kissmyrank-linux'));
  } else if (kind === 'realpenalty') {
    await chmodX(path.join(dest, 'ac_penalty'));
  }
  log(`installed into assetto/${kind}`);
}

export async function writeMarker(info) {
  const lines = Object.entries(info).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`);
  await fs.writeFile(MARKER, `${lines.join('\n')}\n`);
}

export async function install(opts, log) {
  if (!['acsm', 'free'].includes(opts.variant)) throw new Error('choose which Server Manager to install');
  if (opts.variant === 'free') opts.mode = 'single';
  if (!['single', 'multi'].includes(opts.mode)) opts.mode = 'single';
  if (opts.baseUrl && !/^https?:\/\/[^\s'"]+$/.test(opts.baseUrl)) throw new Error('invalid public URL');
  if (opts.baseUrl) opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');

  await fs.mkdir(TMP_DIR, { recursive: true });
  const uploads = await listUploads();

  // validate the choices before downloading or copying anything
  const acChoices = opts.variant === 'acsm' ? ['builtin', 'steam', 'upload', 'existing'] : ['steam', 'upload', 'existing'];
  if (!acChoices.includes(opts.acServer)) throw new Error('choose how to install the Assetto Corsa server');
  if (opts.acServer === 'steam' && (!opts.steam?.user || !opts.steam?.pass)) throw new Error('enter your Steam username and password');
  if (opts.acServer === 'upload' && !uploads.assetto) throw new Error('upload the zip of the dedicated server folder');
  if (opts.acServer === 'existing' && !(await exists(path.join(ASSETTO_DIR, 'acServer')))) {
    throw new Error(`acServer not found in ${ASSETTO_DIR}`);
  }

  if (opts.variant === 'acsm') await installAcsm(log, opts, uploads);
  else await installFree(log, opts);

  await installAcServer(log, opts, uploads);

  for (const kind of Object.keys(PLUGINS)) {
    if (uploads[kind]) await installPlugin(log, kind);
  }

  await writeMarker({
    VARIANT: opts.variant,
    MODE: opts.mode,
    INSTALLED_AT: new Date().toISOString(),
  });
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.rm(RECONFIGURE, { force: true });
  log('== Installation complete');
}
