// Work Board backend.
// The board was first written as a claude.ai Artifact, which reaches its data through
// window.claude.use('db'). This file provides the same small API (collection, doc, where,
// get, set, update, delete, onSnapshot) for the standalone app:
//   - every document is kept in memory and in IndexedDB on this device, so the board opens
//     fast and keeps working offline;
//   - when js/config.js has Supabase keys, the user signs in and every change is synced to a
//     Supabase table, so the same board shows on every device.
(function () {
  'use strict';
  const CFG = window.WB_CONFIG || {};
  const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const BATCH = 500;

  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  function deepMerge(base, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (isObj(v) && isObj(base[k])) deepMerge(base[k], v);
      else base[k] = clone(v);
    }
    return base;
  }
  const parentOf = path => path.slice(0, path.lastIndexOf('/'));
  const idOf = path => path.slice(path.lastIndexOf('/') + 1);

  // ---------- in-memory store and live listeners ----------
  const store = new Map(); // 'tasks/abc' -> data
  const listeners = new Set();
  let ready = false;
  let readyResolve;
  const readyP = new Promise(r => (readyResolve = r));

  const snapDoc = (path, data) => ({ id: idOf(path), exists: data !== undefined, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } });

  function compare(a, op, b) {
    if (op === 'in') return Array.isArray(b) && b.includes(a);
    if (op === 'not-in') return a !== undefined && Array.isArray(b) && !b.includes(a);
    if (op === 'array-contains') return Array.isArray(a) && a.includes(b);
    if (a === undefined || a === null) return false;
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: throw new Error('Unsupported filter ' + op);
    }
  }
  function runQuery(coll, filters) {
    const docs = [];
    for (const [path, data] of store) {
      if (parentOf(path) !== coll) continue;
      if (filters.every(([f, op, v]) => compare(data[f], op, v))) docs.push(snapDoc(path, data));
    }
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
  }

  function notify(paths) {
    if (!ready) return;
    for (const l of listeners) {
      if (l.queued) continue;
      if (![...paths].some(p => (l.doc ? p === l.path : parentOf(p) === l.path))) continue;
      l.queued = true;
      setTimeout(() => { l.queued = false; if (l.live) l.run(); }, 0);
    }
  }
  function listen(l) {
    l.live = true;
    listeners.add(l);
    readyP.then(() => setTimeout(() => l.live && l.run(), 0));
    return () => { l.live = false; listeners.delete(l); };
  }

  // ---------- IndexedDB on this device ----------
  let idb = null;
  function openIdb() {
    return new Promise(resolve => {
      try {
        const req = indexedDB.open('work-board', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('docs');
          d.createObjectStore('outbox');
          d.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  function tx(name, mode, fn) {
    if (!idb) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const t = idb.transaction(name, mode);
        const out = fn(t.objectStore(name));
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
        t.onerror = t.onabort = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }
  const idbAll = name => new Promise(resolve => {
    if (!idb) return resolve([]);
    try {
      const out = [];
      const req = idb.transaction(name).objectStore(name).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out); };
      req.onerror = () => resolve(out);
    } catch { resolve([]); }
  });
  const idbGet = (name, key) => tx(name, 'readonly', s => s.get(key));
  const idbPut = (name, key, val) => tx(name, 'readwrite', s => s.put(val, key));
  const idbDel = (name, key) => tx(name, 'readwrite', s => s.delete(key));
  const idbClear = name => tx(name, 'readwrite', s => s.clear());

  // Writes to IndexedDB are coalesced so a burst of edits (a restore, a bulk change) is one transaction.
  const localDirty = new Map();
  let localTimer = null;
  function saveLocal(path, data) {
    localDirty.set(path, data);
    if (!localTimer) localTimer = setTimeout(flushLocal, 50);
  }
  function flushLocal() {
    localTimer = null;
    if (!idb || !localDirty.size) return;
    const batch = [...localDirty];
    localDirty.clear();
    tx('docs', 'readwrite', s => { for (const [p, d] of batch) d === undefined ? s.delete(p) : s.put(d, p); });
  }

  // Other tabs on this device see changes too.
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('work-board') : null;
  if (bc) bc.onmessage = e => { const { path, data } = e.data || {}; if (!path) return; apply(path, data); };

  function apply(path, data) {
    if (data === undefined) store.delete(path); else store.set(path, data);
    saveLocal(path, data);
    notify([path]);
  }

  // ---------- Supabase sync ----------
  let sb = null, uid = null, email = '';
  const outbox = new Map(); // path -> data (undefined = delete)
  let flushing = false, flushTimer = null, lastError = '';

  function write(path, data) {
    apply(path, data);
    if (bc) bc.postMessage({ path, data });
    if (CLOUD) {
      outbox.set(path, data);
      idbPut('outbox', path, data === undefined ? { del: true } : { data });
      scheduleFlush(30);
    }
    return Promise.resolve();
  }
  function scheduleFlush(ms) {
    status();
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, ms);
  }
  async function flush() {
    if (flushing || !sb || !uid || !outbox.size) { status(); return; }
    flushing = true;
    status();
    try {
      while (outbox.size) {
        const items = [...outbox].slice(0, BATCH);
        const ups = items.filter(([, d]) => d !== undefined);
        const dels = items.filter(([, d]) => d === undefined).map(([p]) => p);
        const now = new Date().toISOString();
        if (ups.length) {
          const { error } = await sb.from('docs').upsert(ups.map(([path, data]) => ({ owner: uid, path, coll: parentOf(path), data, updated_at: now })), { onConflict: 'owner,path' });
          if (error) throw error;
        }
        if (dels.length) {
          const { error } = await sb.from('docs').delete().eq('owner', uid).in('path', dels);
          if (error) throw error;
        }
        // Only drop entries that were not changed again while this batch was in flight.
        for (const [p, d] of items) if (outbox.get(p) === d) { outbox.delete(p); idbDel('outbox', p); }
      }
      lastError = '';
    } catch (e) {
      lastError = (e && e.message) || 'Could not reach the server';
      console.warn('Work Board sync failed; will retry', e);
      flushing = false;
      scheduleFlush(navigator.onLine === false ? 15000 : 5000);
      return;
    }
    flushing = false;
    status();
  }
  window.addEventListener('online', () => { scheduleFlush(0); fullSync().catch(() => {}); });

  async function fullSync() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('docs').select('path,data').eq('owner', uid).order('path').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const server = new Map(rows.map(r => [r.path, r.data]));
    // Changes made here that haven't reached the server yet win over what the server sent.
    for (const [p, d] of outbox) if (d === undefined) server.delete(p); else server.set(p, d);
    const changed = new Set();
    for (const p of store.keys()) if (!server.has(p)) { store.delete(p); changed.add(p); }
    for (const [p, d] of server) {
      const before = store.get(p);
      if (before === undefined || JSON.stringify(before) !== JSON.stringify(d)) { store.set(p, d); changed.add(p); }
    }
    await idbClear('docs');
    await tx('docs', 'readwrite', s => { for (const [p, d] of store) s.put(d, p); });
    notify(changed);
  }

  function subscribe() {
    sb.channel('docs-' + uid)
      // No server-side filter: Supabase can't filter delete events, and row-level security already
      // limits inserts and updates to this person's rows. Deletes carry only the key, so check the owner.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, msg => {
        const row = msg.eventType === 'DELETE' ? msg.old : msg.new;
        if (!row || !row.path || (row.owner && row.owner !== uid) || outbox.has(row.path)) return;
        if (msg.eventType === 'DELETE') { if (store.has(row.path)) apply(row.path, undefined); return; }
        const before = store.get(row.path);
        if (before === undefined || JSON.stringify(before) !== JSON.stringify(row.data)) apply(row.path, row.data);
      })
      .subscribe(st => { if (st === 'SUBSCRIBED') fullSync().catch(() => {}); });
    // Catch up after the tab has been in the background (phones pause sockets).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { fullSync().catch(() => {}); scheduleFlush(0); } });
  }

  // ---------- small status pill and sign-in screen ----------
  let pill = null;
  function status() {
    if (!CLOUD) return;
    if (!pill) {
      pill = document.createElement('button');
      pill.className = 'wb-sync';
      pill.type = 'button';
      pill.addEventListener('click', () => {
        if (!uid) return;
        if (confirm(`Signed in as ${email}.\n\nSign out of the Work Board on this device?`)) signOut();
      });
      document.body.appendChild(pill);
    }
    const n = outbox.size;
    let text, cls;
    if (!uid) { text = 'Not signed in'; cls = 'warn'; }
    else if (n && (navigator.onLine === false || lastError)) { text = `Offline · ${n} change${n === 1 ? '' : 's'} to sync`; cls = 'warn'; }
    else if (n || flushing) { text = 'Saving…'; cls = 'busy'; }
    else { text = 'Synced'; cls = 'ok'; }
    pill.textContent = text;
    pill.dataset.state = cls;
    pill.title = uid ? `Signed in as ${email}. Click to sign out.` : '';
  }
  async function signOut() {
    if (outbox.size && !confirm('Some changes have not reached the server yet and will be lost. Sign out anyway?')) return;
    await sb.auth.signOut();
    await idbClear('docs'); await idbClear('outbox'); await idbClear('meta');
    location.reload();
  }
  function signInScreen() {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'wb-login';
      wrap.innerHTML = `<form class="wb-login-card" autocomplete="on">
        <div class="wb-login-mark">☰</div>
        <h1>Work Board</h1>
        <p>Sign in to open your board.</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
        <div class="wb-login-err" role="alert"></div>
      </form>`;
      document.body.appendChild(wrap);
      const f = wrap.querySelector('form'), errEl = wrap.querySelector('.wb-login-err');
      f.email.focus();
      f.addEventListener('submit', async e => {
        e.preventDefault();
        errEl.textContent = '';
        const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
        const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        btn.disabled = false; btn.textContent = 'Sign in';
        if (error) { errEl.textContent = error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message; return; }
        wrap.remove();
        resolve(data.session);
      });
    });
  }

  // ---------- start ----------
  const loadScript = src => new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement('script'), { src, async: true, onload: resolve, onerror: () => reject(new Error('Could not load ' + src)) });
    document.head.appendChild(el);
  });
  const domReady = new Promise(r => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()));

  async function start() {
    idb = await openIdb();
    await domReady;
    if (CLOUD) {
      if (!window.supabase) await loadScript('vendor/supabase.js');
      if (!window.supabase || !window.supabase.createClient) throw new Error('Supabase library missing');
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
      let { data: { session } } = await sb.auth.getSession();
      status();
      if (!session) session = await signInScreen();
      uid = session.user.id; email = session.user.email || '';
      // The cache on this device belongs to one account; start clean if someone else signs in.
      const owner = await idbGet('meta', 'owner');
      if (owner && owner !== uid) { await idbClear('docs'); await idbClear('outbox'); }
      await idbPut('meta', 'owner', uid);
    }
    for (const [p, d] of await idbAll('docs')) store.set(p, d);
    if (CLOUD) {
      for (const [p, v] of await idbAll('outbox')) outbox.set(p, v.del ? undefined : v.data);
      try { await fullSync(); } catch (e) { lastError = 'offline'; console.warn('Starting from the copy on this device', e); }
      subscribe();
      scheduleFlush(0);
    }
    ready = true;
    readyResolve();
    status();
  }
  const started = start();

  // ---------- the API the app uses ----------
  function docRef(path) {
    return {
      id: idOf(path),
      async get() { await readyP; return snapDoc(path, store.get(path)); },
      set(data) { return readyP.then(() => write(path, clone(data))); },
      async update(patch) {
        await readyP;
        // Merges into the document, creating it if it doesn't exist yet (a new board has no settings).
        return write(path, deepMerge(clone(store.get(path) || {}), patch));
      },
      delete() { return readyP.then(() => (store.has(path) ? write(path, undefined) : undefined)); },
      onSnapshot(next, err) { return listen({ doc: true, path, run: () => { try { next(snapDoc(path, store.get(path))); } catch (e) { err && err(e); } } }); }
    };
  }
  function query(coll, filters) {
    return {
      where(f, op, v) { return query(coll, [...filters, [f, op, v]]); },
      doc(id) { return docRef(coll + '/' + id); },
      async get() { await readyP; return runQuery(coll, filters); },
      onSnapshot(next, err) { return listen({ doc: false, path: coll, run: () => { try { next(runQuery(coll, filters)); } catch (e) { err && err(e); } } }); }
    };
  }
  const db = Object.freeze({ collection: c => query(c, []), doc: docRef });

  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/i.test(filename) ? 'application/json' : 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { status: 'saved' };
    }
  });
  const user = Object.freeze({ can: async () => true, isOwner: () => true, canEdit: () => true });

  // ---------- Google Drive (backup and restore) ----------
  // The board's backup code talks to a "Google Drive" connector with three tools: search_files,
  // create_file and download_file_content. Outside claude.ai those are answered here, straight
  // from the browser to the Drive API, signed in with Google Identity Services. The drive.file
  // scope only lets the app see files it created itself (its backups), not the rest of Drive.
  const GCID = CFG.googleClientId || '';
  const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
  const TOKEN_KEY = 'wb-google-token';
  let gisP = null;
  const loadGis = () => gisP || (gisP = loadScript('https://accounts.google.com/gsi/client').catch(e => { gisP = null; throw e; }));
  function savedToken() {
    try { const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); return t && t.exp > Date.now() + 60000 ? t.token : ''; } catch { return ''; }
  }
  function getToken() {
    const t = savedToken();
    if (t) return Promise.resolve(t);
    return loadGis().then(() => new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: GCID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        prompt: localStorage.getItem('wb-google-ok') ? '' : 'consent',
        callback: r => {
          if (r.error) return reject({ code: 'not_granted', message: r.error_description || r.error });
          try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000 })); localStorage.setItem('wb-google-ok', '1'); } catch {}
          resolve(r.access_token);
        },
        error_callback: e => reject({ code: 'not_granted', message: (e && e.type) || 'popup closed' })
      });
      client.requestAccessToken();
    }));
  }
  async function gfetch(url, init = {}, retried) {
    const token = await getToken();
    let res;
    try { res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } }); }
    catch { throw { code: 'server_unavailable', message: 'Google Drive could not be reached' }; }
    if (res.status === 401 && !retried) { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} return gfetch(url, init, true); }
    if (!res.ok) {
      let msg = res.statusText; try { msg = (await res.json()).error.message || msg; } catch {}
      throw { code: res.status >= 500 ? 'upstream_error' : 'tool_error', message: msg };
    }
    return res;
  }
  const fileOut = f => ({ id: f.id, title: f.name, createdTime: f.createdTime, mimeType: f.mimeType, parentId: (f.parents || [])[0] || '', viewUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` });
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const driveTools = {
    async search_files({ query = '', pageSize = 30 }) {
      const q = `(${query.replace(/\btitle\b/g, 'name')}) and trashed = false`;
      const r = await gfetch(`${DRIVE_API}?${new URLSearchParams({ q, pageSize: String(Math.min(+pageSize || 30, 100)), orderBy: 'createdTime desc', fields: 'files(id,name,createdTime,mimeType,parents,webViewLink)' })}`);
      return { files: ((await r.json()).files || []).map(fileOut) };
    },
    async create_file({ title, contentMimeType, textContent, base64Content, parentId }) {
      const meta = { name: title, mimeType: contentMimeType, ...(parentId ? { parents: [parentId] } : {}) };
      if (contentMimeType === 'application/vnd.google-apps.folder') {
        const r = await gfetch(`${DRIVE_API}?fields=id,name,createdTime,mimeType,parents,webViewLink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
        return fileOut(await r.json());
      }
      const body = new FormData();
      body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      body.append('file', base64Content && base64Content.$file ? base64Content.$file.data : new Blob([textContent || ''], { type: contentMimeType || 'application/octet-stream' }));
      const r = await gfetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,mimeType,parents,webViewLink`, { method: 'POST', body });
      return fileOut(await r.json());
    },
    async download_file_content({ fileId }) {
      const meta = await (await gfetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?fields=id,name,mimeType`)).json();
      const text = await (await gfetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`)).text();
      return { content: toBase64(text), id: meta.id, title: meta.name, mimeType: meta.mimeType };
    }
  };
  const mcp = Object.freeze({
    async listTools() { return { servers: [{ server: 'Google Drive', tools: Object.keys(driveTools) }], fileArgs: true }; },
    async callTool(server, tool, input) {
      if (server !== 'Google Drive' || !driveTools[tool]) throw { code: 'not_in_manifest', message: tool };
      return { payload: await driveTools[tool](input || {}) };
    }
  });
  // "granted" only while a Google sign-in from this tab is still valid, so the daily backup never
  // opens a Google pop-up by itself; otherwise the board asks with a "Back up now" button.
  const permissions = Object.freeze({ async state(name) { return name === 'mcp:Google Drive' && savedToken() ? 'granted' : 'prompt'; } });
  if (GCID) domReady.then(() => loadGis().catch(() => {}));

  window.WB_STANDALONE = true;
  window.WB_HAS_DRIVE = !!GCID;
  window.claude = Object.freeze({
    async use(name) {
      if (name === 'db') { try { await started; return db; } catch (e) { console.error(e); return null; } }
      if (name === 'downloads') return downloads;
      if (name === 'user') return user;
      if (name === 'mcp') return GCID ? mcp : null;
      if (name === 'permissions') return permissions;
      return null;
    }
  });
  // For tests and support: lets a test wait until the board has loaded.
  window.WB_BACKEND = { ready: readyP, cloud: CLOUD, pending: () => outbox.size, flush };
})();
