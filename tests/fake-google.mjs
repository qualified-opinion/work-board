// Test doubles for Google sign-in and the Drive API, served through Playwright routes.
// One in-memory "Drive" is shared by every browser context in the run, like a real account.
export function fakeDrive() {
  const files = new Map(); let n = 0;
  const gsi = `window.google={accounts:{oauth2:{initTokenClient(o){return{requestAccessToken(){window.__gsiCalls=(window.__gsiCalls||0)+1;setTimeout(()=>o.callback({access_token:'tok',expires_in:3600}),10)}}}}}};`;
  async function route(r) {
    const req = r.request(), url = new URL(req.url());
    if (req.headers()['authorization'] !== 'Bearer tok') return r.fulfill({ status: 401, body: '{}' });
    const json = (o, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const out = f => ({ id: f.id, name: f.name, createdTime: f.createdTime, mimeType: f.mimeType, parents: f.parents, webViewLink: 'https://drive.google.com/file/d/' + f.id });
    if (url.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
      const body = req.postDataBuffer().toString('utf8');
      const meta = JSON.parse(body.match(/\{"name"[^\n]*\}/)[0]);
      const content = body.split(/\r\n\r\n/).slice(2).join('\r\n\r\n').replace(/\r\n--[^\r\n]*--\r\n$/, '');
      const f = { id: 'f' + ++n, ...meta, content, createdTime: new Date(Date.now() + n * 1000).toISOString() };
      files.set(f.id, f); return json(out(f));
    }
    if (url.pathname === '/drive/v3/files' && req.method() === 'POST') {
      const f = { id: 'd' + ++n, ...JSON.parse(req.postData()), createdTime: new Date().toISOString() };
      files.set(f.id, f); return json(out(f));
    }
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q');
      const name = (q.match(/name (?:=|contains) '([^']*)'/) || [])[1] || '';
      const exact = /name = '/.test(q), mime = (q.match(/mimeType = '([^']*)'/) || [])[1];
      const list = [...files.values()].filter(f => (exact ? f.name === name : f.name.includes(name)) && (!mime || f.mimeType === mime));
      return json({ files: list.map(out) });
    }
    const m = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m) { const f = files.get(decodeURIComponent(m[1])); if (!f) return json({ error: { message: 'File not found' } }, 404);
      return url.searchParams.get('alt') === 'media' ? r.fulfill({ status: 200, contentType: f.mimeType, body: f.content }) : json(out(f)); }
    return r.fulfill({ status: 404, body: '{}' });
  }
  return { files, install: async ctx => {
    await ctx.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: gsi }));
    await ctx.route('https://www.googleapis.com/**', route);
    await ctx.route('**/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.WB_CONFIG={googleClientId:'test.apps.googleusercontent.com'};" }));
  } };
}
