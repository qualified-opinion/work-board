// Browser tests for the standalone Work Board.
//   npm test            runs both scenarios
// Scenario 1 (this browser only): empty start, restore a backup, edits survive a reload, backup download.
// Scenario 2 (Supabase sync, against tests/fake-supabase.js): sign-in, restore uploads to the server,
// a change from another device shows up, offline edits are kept and sent once back online,
// and a fresh device gets everything from the server.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fakeDrive } from './fake-google.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const backup = join(root, 'tests', 'fixture-backup.json');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = path || 'index.html';
  try { const body = await readFile(join(root, file)); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch();
let failed = false;

async function scenario(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed = true; console.log(`FAIL ${name}\n${e.stack || e}`); }
}
// Fonts come from Google; keep tests offline-safe and fast.
const blockFonts = ctx => ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());

async function restore(p) {
  await p.click('[data-open-settings]');
  await p.setInputFiles('#rsFile', backup);
  await p.click('[data-act="rs-force"], [data-act="rs-go"]');
  await p.waitForFunction(() => /Board restored/.test(document.querySelector('.d-body.backup')?.textContent || ''), null, { timeout: 30000 });
  await p.click('.d-head [data-act="close"]');
}
const docCount = p => p.evaluate(() => new Promise(r => { const q = indexedDB.open('work-board'); q.onsuccess = () => { const c = q.result.transaction('docs').objectStore('docs').count(); c.onsuccess = () => r(c.result); }; }));

for (const width of [1280, 400]) {
  await scenario(`this browser only, ${width}px`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    await blockFonts(ctx);
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(base);
    await p.waitForSelector('[data-open-settings]');
    assert.equal(await p.locator('.wb-sync, .wb-login').count(), 0, 'no sign-in or sync pill without Supabase keys');
    await p.click('[data-open-settings]');
    assert.equal(await p.locator('[data-act="backup-drive"], [data-act="rs-drive"]').count(), 0, 'Google Drive buttons hidden');
    await p.click('.d-head [data-act="close"]');
    await restore(p);
    await p.waitForSelector('.stats');
    assert.match(await p.textContent('.stats'), /Overdue/);
    await p.locator('section.group .row [data-act="tpin"]').first().click();
    await wait(300);
    await p.reload();
    await p.waitForSelector('.focus .row');
    assert.equal(await p.locator('.focus .row').count(), 1, 'pin survives reload');
    assert.ok(await docCount(p) > 300, 'documents saved in IndexedDB');
    await p.click('#settingsBtn');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="backup-dl"]')]);
    assert.match(dl.suggestedFilename(), /^Work Board backup .*\.json$/);
    const saved = JSON.parse(await readFile(await dl.path(), 'utf8'));
    assert.equal(Object.keys(saved.clients).length, 46);
    await p.click('.d-head [data-act="close"]');
    for (const v of ['board', 'clients', 'all', 'notes', 'time', 'calendar', 'deadlines', 'today']) { await p.click(`#tabs button[data-view="${v}"]`); await wait(150); }
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

await scenario('Supabase sync', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await blockFonts(ctx);
  const fake = await readFile(join(root, 'tests', 'fake-supabase.js'), 'utf8');
  await ctx.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'text/javascript', body: fake }));
  await ctx.route('**/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.WB_CONFIG={supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'anon'};" }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
  const pill = () => p.textContent('.wb-sync');
  const serverRows = () => p.evaluate(() => Object.values(window.__server.rows()));

  await p.goto(base);
  await p.waitForSelector('.wb-login');
  await p.fill('.wb-login input[name=email]', 'jan@example.com');
  await p.fill('.wb-login input[name=password]', 'wrong');
  await p.click('.wb-login button');
  await p.waitForFunction(() => document.querySelector('.wb-login-err').textContent.length > 0);
  assert.match(await p.textContent('.wb-login-err'), /don’t match/);
  await p.fill('.wb-login input[name=password]', 'pw');
  await p.click('.wb-login button');
  await p.waitForSelector('[data-open-settings]');

  await restore(p);
  await p.waitForFunction(() => document.querySelector('.wb-sync')?.textContent === 'Synced', null, { timeout: 15000 });
  assert.ok((await serverRows()).length >= 339, 'restore reached the server');

  // A change made on another device arrives live.
  const row = (await serverRows()).find(r => r.coll === 'tasks' && r.data.status === 'In progress');
  const id = row.path.split('/')[1];
  await p.evaluate(r => window.__remote('UPDATE', { ...r, data: { ...r.data, status: 'For review' } }), row);
  await p.waitForFunction(i => document.querySelector(`[data-task="${i}"] select`)?.value === 'For review', id);

  // Offline: the edit is kept, survives a reload, and is sent once the connection is back.
  await p.evaluate(() => (window.__fail = true));
  await p.locator('section.group .row [data-act="tpin"]').first().click();
  await p.waitForFunction(() => /Offline/.test(document.querySelector('.wb-sync')?.textContent || ''), null, { timeout: 10000 });
  await p.reload();
  await p.waitForSelector('.focus .row');
  await p.evaluate(() => { window.__fail = false; window.dispatchEvent(new Event('online')); });
  await p.waitForFunction(() => document.querySelector('.wb-sync')?.textContent === 'Synced', null, { timeout: 15000 });
  assert.equal((await serverRows()).filter(r => r.coll === 'tasks' && r.data.focus).length, 1, 'offline pin reached the server');

  // A new device starts empty and loads everything from the server.
  await p.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('work-board'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await p.reload();
  await p.waitForSelector('.focus .row');
  assert.match(await p.textContent('.stats'), /1\s*For review/);
  assert.match(await pill(), /Synced/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await scenario('Google Drive backup and restore', async () => {
  const drive = fakeDrive();
  // Browser 1: restore the board, see the daily backup prompt, back up.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await blockFonts(ctx); await drive.install(ctx);
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.goto(base);
  await restore(p);
  const backups = () => [...drive.files.values()].filter(f => f.name.startsWith('Work Board backup ')).length;
  const makeDue = async () => { await wait(1500); await p.evaluate(async () => { const db = await window.claude.use('db'); await db.doc('settings/app').update({ lastBackupAt: new Date(Date.now() - 2 * 864e5).toISOString() }); }); await wait(300); };
  // Signed in to Google in this tab: a due backup runs by itself on open.
  await makeDue(); await p.reload();
  for (let i = 0; i < 40 && backups() === 0; i++) await wait(250);
  assert.equal(backups(), 1, 'automatic daily backup ran');
  assert.equal(await p.locator('.wb-due').count(), 0);
  // Google sign-in expired (new day): the board asks with a button instead of opening a pop-up.
  await makeDue(); await p.evaluate(() => sessionStorage.clear()); await p.reload();
  await p.waitForSelector('.wb-due', { timeout: 15000 });
  assert.equal(await p.evaluate(() => window.__gsiCalls || 0), 0, 'no Google pop-up without a click');
  await p.click('.wb-due button.primary');
  await p.waitForSelector('.wb-due', { state: 'detached', timeout: 15000 });
  assert.equal(backups(), 2);
  const names = [...drive.files.values()].map(f => f.name);
  assert.ok(names.includes('Work Board backups'), 'backup folder created');
  const backup = [...drive.files.values()].find(f => f.name.startsWith('Work Board backup '));
  assert.ok(backup && backup.parents && backup.parents[0], 'backup saved inside the folder');
  assert.equal(Object.keys(JSON.parse(backup.content).clients).length, 46);
  assert.deepEqual(errors, []);
  await ctx.close();

  // Browser 2 (a new PC): empty board, restore from the Drive backup.
  const ctx2 = await browser.newContext({ viewport: { width: 400, height: 860 } });
  await blockFonts(ctx2); await drive.install(ctx2);
  const q = await ctx2.newPage(); q.on('pageerror', e => errors.push(e.message));
  await q.goto(base);
  await q.click('[data-open-settings]');
  await q.click('[data-act="rs-drive"]');
  await q.waitForSelector('[data-act="rs-pick"]');
  await q.click('[data-act="rs-pick"]');
  await q.click('[data-act="rs-force"], [data-act="rs-go"]');
  await q.waitForFunction(() => /Board restored/.test(document.querySelector('.d-body.backup')?.textContent || ''), null, { timeout: 30000 });
  await q.click('.d-head [data-act="close"]');
  await q.waitForSelector('.stats');
  assert.match(await q.textContent('.stats'), /Overdue/);
  assert.equal(await q.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  assert.deepEqual(errors, []);
  await ctx2.close();
});

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
