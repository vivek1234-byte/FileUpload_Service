// VORTEX simple frontend: sign in, upload, list, download and delete your files.
// Talks to the Flask API in backend/app/api.py.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'vortex-token';
const USER_KEY = 'vortex-user';
const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

let token = read(TOKEN_KEY);
let files = [];
let quota = null;      // bytes each user may store, from /health
let lastPod = null;
let mode = 'login';    // or 'register'
let uploading = 0;     // bytes of uploads in progress

// ------------------------------------------------------------------ helpers
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message, bad = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

async function errorText(res, fallback) {
  try { return (await res.json()).error || fallback; } catch { return fallback; }
}

// Every API call goes through here so an expired or lost session signs you out.
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && token) {
    signOut(await errorText(res, 'Your session has ended. Please sign in again.'));
    throw new Error('signed out');
  }
  return res;
}

// Asks before anything is downloaded or deleted. Resolves true only on the OK button.
function confirmDialog({ title, text, ok, danger = false }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const okButton = $('confirm-ok');
  okButton.textContent = ok;
  okButton.className = danger ? 'danger' : 'primary';
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
    (danger ? $('confirm-cancel') : okButton).focus(); // deleting defaults to Cancel
  });
}
// A click on the dark backdrop cancels.
$('confirm').addEventListener('click', (e) => { if (e.target === $('confirm')) $('confirm').close('cancel'); });

// ------------------------------------------------------------------ server status
async function checkServer() {
  const badge = $('server');
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const h = await res.json();
    const storage = h.storage === 'minio' ? 'MinIO' : h.volume === 'pvc' ? 'PVC' : h.volume === 'emptyDir' ? 'emptyDir' : 'local disk';
    badge.textContent = `${storage} · pod ${h.pod}`;
    badge.className = 'server ok';
    if (lastPod && h.pod !== lastPod && token) {
      toast(`The server restarted (new pod ${h.pod}). Reloading your files.`);
      refresh();
    }
    lastPod = h.pod;
    if (h.quota !== quota) { quota = h.quota || null; renderUsage(); }
  } catch {
    badge.textContent = 'Server not reachable';
    badge.className = 'server down';
  }
}

// ------------------------------------------------------------------ sign in / sign out
function setMode(next) {
  mode = next;
  const register = mode === 'register';
  $('tab-login').classList.toggle('active', !register);
  $('tab-register').classList.toggle('active', register);
  $('tab-login').setAttribute('aria-selected', String(!register));
  $('tab-register').setAttribute('aria-selected', String(register));
  $('auth-submit').textContent = register ? 'Create account' : 'Sign in';
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-hint').textContent = register
    ? 'Username: 3–20 letters, numbers, _ or -. Password: at least 6 characters.'
    : '';
  $('auth-error').hidden = true;
}
$('tab-login').addEventListener('click', () => setMode('login'));
$('tab-register').addEventListener('click', () => setMode('register'));

function showAuthError(message) {
  $('auth-error').textContent = message;
  $('auth-error').hidden = false;
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  if (mode === 'register' && !NAME_RE.test(username)) return showAuthError('Username must be 3–20 letters, numbers, _ or -.');
  if (mode === 'register' && password.length < 6) return showAuthError('Password must be at least 6 characters.');
  if (!username || !password) return showAuthError('Enter your username and password.');

  const button = $('auth-submit');
  button.disabled = true;
  try {
    const res = await fetch(mode === 'register' ? '/auth/register' : '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return showAuthError(await errorText(res, 'Could not sign in.'));
    const body = await res.json();
    token = body.token;
    write(TOKEN_KEY, token);
    write(USER_KEY, body.username);
    $('password').value = '';
    showApp(body.username);
  } catch {
    showAuthError('The server is not reachable. Try again in a moment.');
  } finally {
    button.disabled = false;
  }
});

function signOut(message) {
  token = null;
  write(TOKEN_KEY, null);
  write(USER_KEY, null);
  files = [];
  $('app').hidden = true;
  $('user-box').hidden = true;
  $('auth').hidden = false;
  $('uploads').replaceChildren();
  setMode('login');
  if (message) showAuthError(message);
  $('username').focus();
}
$('logout').addEventListener('click', () => signOut());

function showApp(username) {
  $('auth').hidden = true;
  $('app').hidden = false;
  $('user-box').hidden = false;
  $('user-name').textContent = username;
  refresh();
}

// ------------------------------------------------------------------ file list
async function refresh() {
  try {
    const res = await api('/files');
    if (!res.ok) throw new Error(await errorText(res, 'Could not load your files'));
    files = await res.json();
    render();
  } catch (err) {
    if (err.message !== 'signed out') toast(err.message, true);
  }
}

function usedBytes() { return files.reduce((sum, f) => sum + f.size, 0); }

function renderUsage() {
  const used = usedBytes();
  const meter = $('usage-bar').parentElement;
  if (!quota) {
    $('usage-text').textContent = `${formatBytes(used)} used`;
    $('usage-bar').style.width = '0';
    return;
  }
  $('limits').textContent = `Up to 200 MB per file · ${formatBytes(quota)} in total`;
  const share = Math.min(used / quota, 1);
  $('usage-text').textContent = `${formatBytes(used)} of ${formatBytes(quota)} used`;
  $('usage-bar').style.width = `${(share * 100).toFixed(1)}%`;
  meter.classList.toggle('warn', share >= 0.8 && share < 0.98);
  meter.classList.toggle('full', share >= 0.98);
}

function render() {
  files.sort((a, b) => a.name.localeCompare(b.name));
  const rows = files.map((f) => {
    const tr = el('tr');
    const download = el('button', 'small-btn', 'Download');
    download.type = 'button';
    download.addEventListener('click', () => askDownload(f));
    const remove = el('button', 'small-btn del', 'Delete');
    remove.type = 'button';
    remove.addEventListener('click', () => askDelete(f));
    const actions = el('td', 'actions');
    actions.append(download, remove);
    tr.append(el('td', 'name', f.name), el('td', 'num', formatBytes(f.size)), actions);
    return tr;
  });
  $('files').tBodies[0].replaceChildren(...rows);
  $('files').hidden = files.length === 0;
  $('empty').hidden = files.length > 0;
  $('count').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '';
  renderUsage();
}

// ------------------------------------------------------------------ download and delete
async function askDownload(f) {
  const yes = await confirmDialog({ title: 'Download this file?', text: `${f.name} (${formatBytes(f.size)})`, ok: 'Download' });
  if (!yes) return;
  try {
    const res = await api(`/download/${encodeURIComponent(f.name)}`);
    if (!res.ok) throw new Error(await errorText(res, 'Download failed'));
    const url = URL.createObjectURL(await res.blob());
    const a = el('a');
    a.href = url;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    if (err.message !== 'signed out') toast(`${f.name}: ${err.message}`, true);
  }
}

async function askDelete(f) {
  const yes = await confirmDialog({ title: 'Delete this file?', text: `${f.name} will be removed for good.`, ok: 'Delete', danger: true });
  if (!yes) return;
  try {
    const res = await api(`/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorText(res, 'Delete failed'));
    toast(`Deleted ${f.name}`);
    refresh();
  } catch (err) {
    if (err.message !== 'signed out') toast(`${f.name}: ${err.message}`, true);
  }
}

// ------------------------------------------------------------------ delete account
const deleteDialog = $('delete-dialog');

$('delete-account').addEventListener('click', () => {
  const n = files.length;
  $('delete-summary').textContent = n ? `your ${n} file${n === 1 ? '' : 's'} (${formatBytes(usedBytes())})` : 'all your files';
  $('delete-password').value = '';
  $('delete-error').hidden = true;
  deleteDialog.showModal();
  $('delete-cancel').focus(); // the safe choice is selected by default
});
$('delete-cancel').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('click', (e) => { if (e.target === deleteDialog) deleteDialog.close(); });

$('delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('delete-password').value;
  const showError = (message) => { $('delete-error').textContent = message; $('delete-error').hidden = false; };
  if (!password) return showError('Enter your password.');

  const button = $('delete-confirm');
  button.disabled = true;
  try {
    const res = await api('/auth/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return showError(await errorText(res, 'Could not delete the account'));
    deleteDialog.close();
    signOut();
    toast('Your account and all your files were deleted.');
  } catch (err) {
    if (err.message !== 'signed out') showError('The server is not reachable. Try again in a moment.');
    else deleteDialog.close();
  } finally {
    $('delete-password').value = '';
    button.disabled = false;
  }
});

// ------------------------------------------------------------------ upload
function fits(file) {
  if (!quota) return true;
  const existing = files.find((f) => f.name === file.name)?.size || 0; // replacing frees the old size
  return usedBytes() - existing + uploading + file.size <= quota;
}

function upload(file) {
  const li = el('li');
  const line = el('div', 'line');
  const state = el('span', 'state', 'Waiting…');
  line.append(el('span', 'name', file.name), state);
  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);
  li.append(line, bar);
  $('uploads').prepend(li);

  const fail = (message) => {
    li.className = 'failed';
    state.textContent = message;
    fill.style.width = '100%';
  };

  if (!fits(file)) {
    const left = Math.max(quota - usedBytes() - uploading, 0);
    return fail(`Not enough space: ${formatBytes(left)} left`);
  }

  uploading += file.size;
  const form = new FormData();
  form.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    fill.style.width = `${pct}%`;
    state.textContent = `${pct}%`;
  };
  xhr.onloadend = () => {
    uploading -= file.size;
    if (xhr.status === 201) {
      li.className = 'done';
      state.textContent = 'Uploaded';
      fill.style.width = '100%';
      refresh();
      return;
    }
    let message = xhr.status ? `Failed (${xhr.status})` : 'Failed: server not reachable';
    try { message = JSON.parse(xhr.responseText).error || message; } catch { /* not JSON */ }
    if (xhr.status === 401) return signOut(message);
    fail(message);
  };
  xhr.send(form);
}

function uploadAll(list) {
  if (!token) return;
  [...list].forEach(upload);
}

$('file-input').addEventListener('change', (e) => {
  uploadAll(e.target.files);
  e.target.value = '';
});

// Drag and drop anywhere on the page; the drop box lights up.
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (token) { dragDepth++; $('drop').classList.add('over'); } });
addEventListener('dragleave', () => { dragDepth = Math.max(dragDepth - 1, 0); if (!dragDepth) $('drop').classList.remove('over'); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('over');
  if (e.dataTransfer?.files?.length) uploadAll(e.dataTransfer.files);
});

// ------------------------------------------------------------------ start
async function start() {
  setMode('login');
  $('auth-submit').disabled = false;
  checkServer();
  setInterval(checkServer, 5000);

  if (token) {
    try {
      const res = await api('/auth/me');
      if (res.ok) return showApp((await res.json()).username);
    } catch { /* signed out, or server down */ }
    if (!token) return; // api() already signed out with a message
  }
  signOut();
}
start();
