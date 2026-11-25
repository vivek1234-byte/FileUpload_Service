// Talks to the File Upload Service backend.
//
// Backend contract (what the real server should implement):
//   POST   /auth/register     { username, password } -> 201 { username, token }   (409 if name taken)
//   POST   /auth/login        { username, password } -> 200 { username, token }   (401 if wrong)
//   GET    /auth/me           -> { username }                                     (401 if token invalid)
//   GET    /health            -> { status: "ok", pod, storage: "local"|"minio", volume: "emptyDir"|"pvc" }
//   GET    /files             -> [{ name, size }]        only the signed-in user's files
//   POST   /upload            -> multipart form, field "file"
//   GET    /download/<name>   -> the file
//   DELETE /files/<name>      -> deletes the file
// Every call except /health and /auth/register|login sends "Authorization: Bearer <token>".
//
// With no backend, the page runs in DEMO mode: accounts are kept in this browser's
// localStorage (passwords salted + hashed) and each account's files in IndexedDB.
// That is for trying the app out only — it is not real security.

import { hashPassword, randomHex } from './sha256.js';

const BASE = (window.API_BASE || '').replace(/\/$/, '');
const JSON_HEADERS = { Accept: 'application/json' };
const VOLUMES = ['emptyDir', 'pvc', 'minio'];
const SESSION_KEY = 'vortex-session';
const ACCOUNTS_KEY = 'vortex-accounts';
const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// ------------------------------------------------------------------ demo file storage (IndexedDB, per user)
const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const r = indexedDB.open('vortex-demo', 1);
        r.onupgradeneeded = () => {
          const store = r.result.createObjectStore('files', { keyPath: ['user', 'name'] });
          store.createIndex('user', 'user');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}
const memory = new Map(); // fallback when IndexedDB is blocked
const memKey = (user, name) => `${user}\u0000${name}`;
async function store(mode) {
  const db = await openDb();
  return db ? db.transaction('files', mode).objectStore('files') : null;
}

const demoStore = {
  async list(user) {
    const s = await store('readonly');
    if (!s) return [...memory.values()].filter((f) => f.user === user);
    return request(s.index('user').getAll(user));
  },
  async get(user, name) {
    const s = await store('readonly');
    return s ? request(s.get([user, name])) : memory.get(memKey(user, name));
  },
  async put(user, name, blob) {
    const record = { user, name, size: blob.size, blob };
    const s = await store('readwrite');
    if (s) await request(s.put(record));
    else memory.set(memKey(user, name), record);
  },
  async delete(user, name) {
    if (!(await this.get(user, name))) return false;
    const s = await store('readwrite');
    if (s) await request(s.delete([user, name]));
    else memory.delete(memKey(user, name));
    return true;
  },
  // An emptyDir disk belongs to the pod, so a wipe loses every user's files.
  async clearAll() {
    const s = await store('readwrite');
    if (s) await request(s.clear());
    memory.clear();
  },
};

// ------------------------------------------------------------------ api
const randomId = () => Math.random().toString(36).slice(2, 7);
const randomPod = () => `file-upload-${randomId()}-${randomId()}`;

async function errorText(res, fallback) {
  try { return (await res.json()).error || `${fallback} (${res.status})`; } catch { return `${fallback} (${res.status})`; }
}

async function fetchHealth() {
  try {
    const res = await fetch(`${BASE}/health`, { headers: JSON_HEADERS, cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body.status === 'ok' ? body : null;
  } catch {
    return null;
  }
}

export const api = {
  mode: 'demo',
  user: null, // { username, key }
  token: null,
  onUnauthorized: null, // set by the page: called when the server rejects the token
  demo: { pod: randomPod(), volume: 'emptyDir', downUntil: 0 },

  async init() {
    this.mode = (await fetchHealth()) ? 'live' : 'demo';
  },

  async _fetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${BASE}${path}`, { ...opts, headers, cache: 'no-store' });
    if (res.status === 401) {
      this.onUnauthorized?.(await errorText(res, 'Session expired'));
      throw new Error('session expired — please sign in again');
    }
    return res;
  },

  // ---------------- accounts
  async restoreSession() {
    const s = readJson(SESSION_KEY, null);
    if (!s || s.mode !== this.mode || !s.username) return null;
    if (this.mode === 'demo') {
      const acc = readJson(ACCOUNTS_KEY, {})[s.username.toLowerCase()];
      return acc ? this._setUser(acc.display, null, false) : null;
    }
    this.token = s.token;
    try {
      const res = await fetch(`${BASE}/auth/me`, { headers: { ...JSON_HEADERS, Authorization: `Bearer ${s.token}` }, cache: 'no-store' });
      if (!res.ok) throw new Error();
      const body = await res.json();
      return this._setUser(body.username || s.username, s.token, false);
    } catch {
      this.token = null;
      return null;
    }
  },

  async register(username, password) {
    username = username.trim();
    if (!NAME_RE.test(username)) throw new Error('Player name must be 3–20 letters, numbers, _ or -');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (this.mode === 'live') return this._authRequest('/auth/register', username, password);

    const accounts = readJson(ACCOUNTS_KEY, {});
    const key = username.toLowerCase();
    if (accounts[key]) throw new Error('That player name is already taken');
    const salt = randomHex(16);
    accounts[key] = { display: username, salt, hash: hashPassword(password, salt), created: Date.now() };
    if (!writeJson(ACCOUNTS_KEY, accounts)) throw new Error('This browser is blocking storage, so accounts cannot be saved');
    return this._setUser(username, null, true);
  },

  async login(username, password) {
    username = username.trim();
    if (!username || !password) throw new Error('Enter your player name and password');
    if (this.mode === 'live') return this._authRequest('/auth/login', username, password);

    const acc = readJson(ACCOUNTS_KEY, {})[username.toLowerCase()];
    if (!acc || hashPassword(password, acc.salt) !== acc.hash) throw new Error('Wrong player name or password');
    return this._setUser(acc.display, null, true);
  },

  async _authRequest(path, username, password) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      throw new Error('Cannot reach the server');
    }
    let body = {};
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      if (body.error) throw new Error(body.error);
      if (res.status === 409) throw new Error('That player name is already taken');
      if (res.status === 401) throw new Error('Wrong player name or password');
      throw new Error(`Sign-in failed (${res.status})`);
    }
    if (!body.token) throw new Error('The server did not return a session token');
    return this._setUser(body.username || username, body.token, true);
  },

  _setUser(username, token, persist) {
    this.user = { username, key: username.toLowerCase() };
    this.token = token;
    if (persist) writeJson(SESSION_KEY, { mode: this.mode, username, token });
    return this.user;
  },

  demoAccountCount() {
    return Object.keys(readJson(ACCOUNTS_KEY, {})).length;
  },

  logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
    this.user = null;
    this.token = null;
  },

  // ---------------- server status
  // Returns the health body, or null while the server is unreachable.
  async health() {
    if (this.mode === 'live') return fetchHealth();
    if (performance.now() < this.demo.downUntil) return null;
    const v = this.demo.volume;
    return { status: 'ok', pod: this.demo.pod, storage: v === 'minio' ? 'minio' : 'local', volume: v === 'minio' ? null : v };
  },

  // Demo only: pretend `kubectl delete pod` happened.
  async simulateWipe() {
    const d = this.demo;
    d.downUntil = performance.now() + 1600;
    d.pod = randomPod();
    if (d.volume === 'emptyDir') await demoStore.clearAll();
  },

  // Demo only: switch between emptyDir, PVC and MinIO storage.
  cycleVolume() {
    const d = this.demo;
    d.volume = VOLUMES[(VOLUMES.indexOf(d.volume) + 1) % VOLUMES.length];
    return d.volume;
  },

  // ---------------- files (always the signed-in user's)
  async list() {
    if (this.mode === 'demo') {
      return (await demoStore.list(this.user.key)).map((f) => ({ name: f.name, size: f.size }));
    }
    const res = await this._fetch('/files', { headers: JSON_HEADERS });
    if (!res.ok) throw new Error(await errorText(res, 'list failed'));
    return res.json();
  },

  // onProgress receives a number from 0 to 1.
  upload(file, onProgress) {
    if (this.mode === 'demo') {
      const user = this.user.key;
      return new Promise((resolve, reject) => {
        const duration = 1400 + Math.min(file.size / 4e5, 1) * 2600;
        const start = performance.now();
        const tick = () => {
          const p = Math.min((performance.now() - start) / duration, 1);
          onProgress(p);
          if (p < 1) return setTimeout(tick, 60);
          demoStore.put(user, file.name, file).then(() => resolve({ uploaded: file.name }), reject);
        };
        tick();
      });
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('file', file);
      xhr.open('POST', `${BASE}/upload`);
      xhr.setRequestHeader('Accept', 'application/json');
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(); return; }
        if (xhr.status === 401) this.onUnauthorized?.();
        let message = `upload failed (${xhr.status})`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* not JSON */ }
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(form);
    });
  },

  async remove(name) {
    if (this.mode === 'demo') {
      if (!(await demoStore.delete(this.user.key, name))) throw new Error('file not found');
      return;
    }
    const res = await this._fetch(`/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorText(res, 'delete failed'));
  },

  async download(name) {
    let blob;
    if (this.mode === 'demo') {
      blob = (await demoStore.get(this.user.key, name))?.blob;
    } else {
      const res = await this._fetch(`/download/${encodeURIComponent(name)}`);
      if (res.ok) blob = await res.blob();
    }
    if (!blob) throw new Error('file not found');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};
