'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'x-acsetup': '1', ...(opts.headers || {}) },
  });
  return res;
}

function radio(name) {
  return $(`input[name="${name}"]:checked`)?.value;
}

function setRadio(name, value) {
  const el = $(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function fmtSize(bytes) {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// --- conditional sections -------------------------------------------------

function refreshVisibility() {
  for (const el of $$('[data-show]')) {
    const [name, value] = el.dataset.show.split('=');
    el.hidden = radio(name) !== value;
  }
}

// --- uploads --------------------------------------------------------------

function setUploadStatus(box, meta, error) {
  const status = $('.upload-status', box);
  status.classList.toggle('ok', Boolean(meta));
  status.classList.toggle('err', Boolean(error));
  status.textContent = error || (meta ? `✓ ${meta.name} (${fmtSize(meta.size)})` : 'no file');
  $('.remove', box).hidden = !meta;
}

function setupUpload(box) {
  const kind = box.dataset.kind;
  box.append($('#upload-tpl').content.cloneNode(true));
  const input = $('input[type=file]', box);
  if (box.dataset.accept) input.accept = box.dataset.accept;
  const progress = $('progress', box);

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload/${kind}?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('x-acsetup', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    progress.hidden = false;
    progress.value = 0;
    $('.upload-status', box).textContent = `uploading ${file.name}…`;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress.value = e.loaded / e.total; };
    xhr.onload = () => {
      progress.hidden = true;
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200) setUploadStatus(box, body);
      else setUploadStatus(box, null, `error: ${body.error || xhr.status}`);
      input.value = '';
    };
    xhr.onerror = () => {
      progress.hidden = true;
      setUploadStatus(box, null, 'network error during upload');
    };
    xhr.send(file);
  });

  $('.remove', box).addEventListener('click', async () => {
    await api(`/api/upload/${kind}`, { method: 'DELETE' });
    setUploadStatus(box, null);
  });
}

// --- install --------------------------------------------------------------

function waitForServerManager() {
  const tick = async () => {
    try {
      const res = await fetch('/healthcheck.json', { cache: 'no-store' });
      if (!res.headers.get('x-ac-setup')) {
        window.location.href = '/';
        return;
      }
    } catch { /* restarting */ }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2500);
}

async function runInstall(e) {
  e.preventDefault();
  const btn = $('#install');
  const log = $('#log');
  const err = $('#form-error');
  err.hidden = true;
  log.hidden = false;
  log.textContent = '';
  btn.disabled = true;

  const opts = {
    variant: radio('variant'),
    mode: radio('mode'),
    servers: $('#servers').value,
    acServer: radio('acServer'),
    steam: {
      user: $('#steam-user').value.trim(),
      pass: $('#steam-pass').value,
      guard: $('#steam-guard').value.trim(),
    },
    baseUrl: $('#base-url').value.trim(),
  };

  let result = null;
  try {
    const res = await api('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line === '@@DONE') result = { ok: true };
        else if (line.startsWith('@@ERROR ')) result = { ok: false, message: line.slice(8) };
        else log.textContent += `${line}\n`;
      }
      log.scrollTop = log.scrollHeight;
    }
  } catch (ex) {
    result = { ok: false, message: ex.message };
  }

  if (result?.ok) {
    $('#done').hidden = false;
    waitForServerManager();
  } else {
    err.textContent = `Installation failed: ${result?.message || 'connection lost'}`;
    err.hidden = false;
    btn.disabled = false;
  }
}

// --- bootstrap ------------------------------------------------------------

function showSetup(state) {
  $('#login').hidden = true;
  $('#setup').hidden = false;
  $('#free-url').textContent = state.freeUrl;
  $('#base-url').value = window.location.origin;
  if (state.hasConfig) $('#base-url').closest('label').hidden = true;

  for (const box of $$('.upload')) {
    setupUpload(box);
    setUploadStatus(box, state.uploads[box.dataset.kind] || null);
  }
  if (state.hasLicense) {
    const box = $('.upload[data-kind="license"]');
    if (!state.uploads.license) $('.upload-status', box).textContent = 'already present (upload only to replace it)';
  }

  if (state.servers) $('#servers').value = state.servers;
  $('#existing-ac').hidden = !state.hasAcServer;
  if (state.hasAcServer) setRadio('acServer', 'existing');

  if (state.installed) {
    const { VARIANT, MODE } = state.installed;
    setRadio('variant', VARIANT);
    setRadio('mode', MODE);
    $('#existing').hidden = false;
    $('#existing-desc').textContent =
      `${VARIANT === 'free' ? 'free Server Manager' : 'ACSM'} (${MODE === 'multi' ? 'multiserver' : 'single server'})`;
    const acsmBox = $('.upload[data-kind="acsm"]');
    if (VARIANT === 'acsm' && !state.uploads.acsm) {
      $('.upload-status', acsmBox).textContent = 'already installed (upload only to update)';
    }
  }

  refreshVisibility();
}

async function init() {
  for (const el of $$('input[type=radio]')) el.addEventListener('change', refreshVisibility);
  $('#setup').addEventListener('submit', runInstall);

  $('#skip').addEventListener('click', async () => {
    const res = await api('/api/skip', { method: 'POST' });
    if (res.ok) {
      $('#done').hidden = false;
      waitForServerManager();
    }
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#password').value }),
    });
    if (res.ok) return load();
    const body = await res.json().catch(() => ({}));
    $('#login-error').textContent = body.error || 'sign in failed';
    $('#login-error').hidden = false;
  });

  await load();
}

async function load() {
  const res = await api('/api/state');
  if (res.status === 401) {
    $('#login').hidden = false;
    $('#password').focus();
    return;
  }
  showSetup(await res.json());
}

init();
