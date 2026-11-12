const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
// يشتغل سواء الملفات داخل مجلد public أو مرفوعة مباشرة بجانب server.js
const ROOT = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const ALLOWED = new Set(['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png']);
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  let name = path.basename(decodeURIComponent(req.url.split('?')[0]));
  if (!name) name = 'index.html';
  const file = path.join(ROOT, name);
  if (!ALLOWED.has(name) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const docs = new Map();           // path -> {data, ts}
const subs = new Set();           // {ws, sid, path, kind}
const DOC = /^(rooms|races)\/[A-Z0-9]{4}(\/p\/[A-Za-z0-9_-]{1,64})?$/;
const COL = /^(rooms|races)\/[A-Z0-9]{4}\/p$/;

const snapDoc = p => { const d = docs.get(p); return d ? { exists: true, data: d.data } : { exists: false }; };
function snapCol(p) {
  const pre = p + '/', out = [];
  for (const [k, v] of docs) if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) out.push({ id: k.slice(pre.length), data: v.data });
  return out;
}
function push(s) {
  if (s.ws.readyState !== 1) return;
  s.ws.send(JSON.stringify(s.kind === 'doc' ? { t: 'doc', sid: s.sid, ...snapDoc(s.path) } : { t: 'col', sid: s.sid, docs: snapCol(s.path) }));
}
function touched(p) {
  for (const s of subs) if (s.kind === 'doc' ? s.path === p : p.startsWith(s.path + '/')) push(s);
}

wss.on('connection', ws => {
  ws.cnt = 0;
  const reply = (id, o) => ws.send(JSON.stringify({ t: 'res', id, ...o }));
  ws.on('message', raw => {
    if (++ws.cnt > 60) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const p = m.path, id = m.id;
    if (m.op === 'unsub') { for (const s of subs) if (s.ws === ws && s.sid === m.sid) subs.delete(s); return; }
    if (m.op === 'sub') {
      const kind = m.kind === 'col' ? 'col' : 'doc';
      if (!(kind === 'col' ? COL : DOC).test(p || '')) return;
      const sid = String(m.sid).slice(0, 20);
      for (const s of subs) if (s.ws === ws && s.sid === sid) subs.delete(s);
      const s = { ws, sid, path: p, kind }; subs.add(s); push(s); return;
    }
    if (!DOC.test(p || '')) return reply(id, { err: 'bad path' });
    if (m.op === 'get') return reply(id, snapDoc(p));
    if (m.op === 'delete') { docs.delete(p); touched(p); return reply(id, { ok: true }); }
    if (m.op === 'set' || m.op === 'update') {
      if (!m.data || typeof m.data !== 'object' || Array.isArray(m.data) || JSON.stringify(m.data).length > 8000) return reply(id, { err: 'bad data' });
      if (!docs.has(p) && docs.size > 5000) return reply(id, { err: 'full' });
      const old = docs.get(p);
      docs.set(p, { data: m.op === 'update' && old ? { ...old.data, ...m.data } : m.data, ts: Date.now() });
      touched(p); return reply(id, { ok: true });
    }
  });
  ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
});

setInterval(() => wss.clients.forEach(c => c.ping()), 25000);
setInterval(() => { const lim = Date.now() - 6 * 3600e3; for (const [k, v] of docs) if (v.ts < lim) docs.delete(k); }, 600e3);
setInterval(() => { wss.clients.forEach(c => { c.cnt = 0; }); }, 1000);

server.listen(PORT, () => console.log('listening on', PORT));
