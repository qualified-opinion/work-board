// Checks for the fixes from the October 2026 review: timers across midnight, entry edits, deleting a running task,
// removed documents, saves before a reload, the backup reminder and restoring while a timer runs.
import { createServer } from 'node:http'; import { readFile } from 'node:fs/promises'; import { extname, join } from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict'; import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url)), backup = join(root, 'tests', 'fixture-backup.json');
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const srv = createServer(async (q, r) => { const f = decodeURIComponent(new URL(q.url,'http://x').pathname).replace(/^\/+/,'') || 'index.html'; try { const b = await readFile(join(root, f)); r.writeHead(200, {'content-type': types[extname(f)] || 'application/octet-stream'}); r.end(b); } catch { r.writeHead(404); r.end(); } });
await new Promise(r => srv.listen(0, r)); const base = `http://localhost:${srv.address().port}/`;
const W = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch();
const ctx = await b.newContext({viewport:{width:1280,height:900}, timezoneId:'Australia/Sydney'}); await ctx.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
await ctx.clock.install({time: new Date('2026-10-21T23:30:00+11:00')});
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
const dbEval = fn => p.evaluate(`(async () => { const db = await window.claude.use('db'); return (${fn})(db); })()`);
await p.goto(base); await p.click('[data-open-settings]'); await p.setInputFiles('#rsFile', backup);
await p.click('[data-act="rs-force"], [data-act="rs-go"]');
await p.waitForFunction(() => /Board restored/.test(document.querySelector('.d-body.backup')?.textContent || ''), null, {timeout: 30000});
await p.click('.d-head [data-act="close"]');

// 1. Free timer across midnight → one entry per day.
await p.click('#tabs button[data-view="time"]'); await p.fill('#ts-what', 'Late BAS'); await p.click('[data-act="ts-start"]'); await W(300);
await ctx.clock.fastForward('01:15:00'); await W(300);
await p.click('[data-act="fstop"]'); await W(800);
const days = await dbEval(`async db => { const a = (await db.doc('time/2026-10-21').get()).data(), c = (await db.doc('time/2026-10-22').get()).data(); return [a && a.entries.filter(e => e.title === 'Late BAS').map(e => e.sec), c && c.entries.filter(e => e.title === 'Late BAS').map(e => e.sec)]; }`);
console.log('midnight split', JSON.stringify(days)); assert.equal(days[0].length, 1); assert.equal(days[1].length, 1); assert.ok(Math.abs(days[1][0] - 2700) < 60 && Math.abs(days[0][0] + days[1][0] - 4500) < 3);

// 2. Editing a 30-second entry keeps it at 30 seconds.
await p.fill('#ts-what', 'Quick call'); await p.click('[data-act="ts-start"]'); await W(200); await ctx.clock.fastForward(30000); await W(200); await p.click('[data-act="fstop"]'); await W(800);
await p.locator('.trow', {hasText: 'Quick call'}).first().click(); await W(300);
await p.fill('#x-notes', 'note added'); await p.click('[data-act="save-time"]'); await W(800);
const qc = await dbEval(`async db => (await db.doc('time/2026-10-22').get()).data().entries.find(e => e.title === 'Quick call')`);
console.log('edit keeps length', qc.sec, qc.notes); assert.equal(qc.sec, 30); assert.equal(qc.notes, 'note added');

// 3. Deleting a one-off task with a running timer logs its time.
await dbEval(`async db => db.doc('tasks/one-test').set({title:'One-off test', client:'', clientId:'', status:'In progress', due:'2026-10-25', owner:'JD', ws:'other', steps:[], timerStart: new Date(Date.now() - 40*60e3).toISOString(), timeSec:0})`);
await p.click('#tabs button[data-view="all"]'); await W(400);
await p.locator('[data-task="one-test"] .t1').first().click(); await W(300);
await p.click('.d-foot [data-act="ask-del"]'); await p.click('[data-act="del-task"]'); await W(1000);
const del = await dbEval(`async db => ({ gone: !(await db.doc('tasks/one-test').get()).exists, logged: (await db.doc('time/2026-10-22').get()).data().entries.filter(e => e.taskId === 'one-test').reduce((a,e) => a + e.sec, 0) })`);
console.log('delete running task', JSON.stringify(del)); assert.ok(del.gone); assert.ok(del.logged >= 2390 && del.logged <= 2410);

// 4. update() on a removed task no longer recreates a fragment.
const stub = await dbEval(`async db => { const ref = db.doc('tasks/zz-gone'); let code = ''; try { await ref.update({notes:'x'}); } catch (e) { code = e.code; } return {code, exists: (await ref.get()).exists}; }`);
console.log('update removed doc', JSON.stringify(stub)); assert.deepEqual(stub, {code:'invalid_argument', exists:false});

// 5. A change saved right before a reload survives it.
const tid = await p.evaluate(() => document.querySelector('[data-task]').dataset.task);
await dbEval(`async db => db.doc('tasks/${tid}').update({notes: 'SAVED-NOTE'})`); await p.reload(); await W(1500);
const kept = await dbEval(`async db => (await db.doc('tasks/${tid}').get()).data().notes`);
console.log('survives reload', kept); assert.equal(kept, 'SAVED-NOTE');

// 6. Weekly download reminder shows (Drive off), and goes once a copy is downloaded.
await p.waitForSelector('.wb-due', {timeout: 10000}); console.log('reminder', (await p.textContent('.wb-due')).slice(0, 60));
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.wb-due button.primary')]); await W(500);
assert.equal(await p.locator('.wb-due').count(), 0);

// 7. Restore while a task timer runs: the running timer carries on, and the backup never revives an old one.
await p.locator('section.group .row [data-act="tstart"], [data-act="tstart"]').first().click(); await W(500);
const run1 = await dbEval(`async db => (await db.collection('tasks').get()).docs.filter(d => d.data().timerStart).map(d => [d.id, d.data().timerStart])`);
const data = JSON.parse(await readFile(backup, 'utf8')); const ids = Object.keys(data.tasks); const other = ids.find(i => i !== run1[0][0]);
data.tasks[other].timerStart = '2026-10-19T09:00:00.000Z';
await p.click('#settingsBtn'); await p.setInputFiles('#rsFile', {name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))});
await p.click('[data-act="rs-force"], [data-act="rs-go"]'); await p.waitForFunction(() => /restored|already matches/.test(document.querySelector('.d-body.backup')?.textContent || ''), null, {timeout: 30000});
const run2 = await dbEval(`async db => (await db.collection('tasks').get()).docs.filter(d => d.data().timerStart).map(d => [d.id, d.data().timerStart])`);
console.log('restore timers', JSON.stringify(run1), '->', JSON.stringify(run2)); assert.deepEqual(run2, run1);
console.log('errors', errs); assert.deepEqual(errs, []);
await b.close(); srv.close();
