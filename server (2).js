const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;

// بوابة الدخول بالكود: تتفعل إذا حطيت متغير ADMIN_KEY في Railway
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GATE = !!ADMIN_KEY;
const SESSION_MS = (+process.env.SESSION_HOURS || 6) * 3600e3;
const CODE_MS = (+process.env.CODE_MINUTES || 60) * 60e3;
const codes = new Map(), sessions = new Map(), tries = new Map();

const ROOT = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const ALLOWED = new Set(['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png']);
const PUBLIC_FILES = new Set(['sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png']);
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png' };
const HTMLH = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sid = req => { const m = /(?:^|; )sid=([a-f0-9]{48})/.exec(req.headers.cookie || ''); return m && m[1]; };
const authed = req => { if (!GATE) return true; const t = sid(req), e = t && sessions.get(t); return !!e && e > Date.now(); };
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

const GATE_HTML = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ركن الألعاب</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12101c;color:#f2efff;font-family:"Segoe UI",Tahoma,sans-serif}
.b{background:#1c1930;border:1px solid #2f2a4a;border-radius:18px;padding:28px;width:min(340px,90vw);text-align:center}
input{width:100%;box-sizing:border-box;font-size:1.6rem;text-align:center;letter-spacing:.3em;background:#12101c;color:#f2efff;border:2px solid #2f2a4a;border-radius:12px;padding:12px;margin:14px 0}
button{background:#ffc24b;color:#111;border:0;border-radius:12px;padding:12px 28px;font:inherit;font-weight:700;cursor:pointer}
#m{min-height:24px;color:#ff6f91;margin-top:10px}</style></head><body><div class="b"><h2>🎮 ركن الألعاب</h2><p style="color:#9a94bd">اكتب كود الدخول اللي أعطاك إياه صاحب اللعبة</p>
<input id="c" inputmode="numeric" maxlength="6" autofocus placeholder="••••••"><button onclick="go()">دخول</button><div id="m"></div></div>
<script>const c=document.getElementById('c');c.addEventListener('keydown',e=>{if(e.key==='Enter')go()});
async function go(){const r=await fetch('/enter',{method:'POST',body:JSON.stringify({code:c.value})});
if(r.status===429){m.textContent='محاولات كثيرة، انتظر دقيقة.';return}
const j=await r.json();if(j.ok)location.reload();else m.textContent='الكود غير صحيح أو انتهى.'}</script></body></html>`;
const adminHtml = code => `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>كود دخول</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12101c;color:#f2efff;font-family:"Segoe UI",Tahoma,sans-serif;text-align:center}
b{display:block;font-size:3rem;letter-spacing:.3em;color:#ffc24b;margin:16px 0}a{color:#3fd9b5}</style></head><body><div>
<p>كود دخول جديد (يشتغل لمرة وحدة، ومدته ${CODE_MS / 60000} دقيقة):</p><b>${code}</b><p><a href="">حدّث الصفحة للحصول على كود ثاني</a></p></div></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/health') { res.end('ok'); return; }

  if (GATE && p === '/admin') {
    if (!same(url.searchParams.get('key') || '', ADMIN_KEY)) { res.writeHead(404); res.end('not found'); return; }
    const code = String(crypto.randomInt(100000, 1000000));
    codes.set(code, Date.now() + CODE_MS);
    res.writeHead(200, HTMLH); res.end(adminHtml(code)); return;
  }

  if (GATE && p === '/enter' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 200) req.destroy(); });
    req.on('end', () => {
      const now = Date.now(), a = ipOf(req), t = tries.get(a) || { n: 0, r: 0 };
      if (now > t.r) { t.n = 0; t.r = now + 60000; }
      tries.set(a, t);
      if (++t.n > 5) { res.writeHead(429); res.end('{"ok":false}'); return; }
      let c = ''; try { c = String(JSON.parse(body).code || '').trim(); } catch {}
      const exp = codes.get(c), h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (exp && exp > now) {
        codes.delete(c);
        const s = crypto.randomBytes(24).toString('hex');
        sessions.set(s, now + SESSION_MS);
        h['Set-Cookie'] = `sid=${s}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
        res.writeHead(200, h); res.end('{"ok":true}');
      } else { res.writeHead(200, h); res.end('{"ok":false}'); }
    });
    return;
  }

  let name = path.basename(decodeURIComponent(p));
  if (!name) name = 'index.html';
  const file = path.join(ROOT, name);
  if (!ALLOWED.has(name) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  if (!PUBLIC_FILES.has(name) && !authed(req)) { res.writeHead(200, HTMLH); res.end(GATE_HTML); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, verifyClient: (info, cb) => cb(authed(info.req), 401, 'unauthorized') });
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
setInterval(() => { const lim = Date.now() - 6 * 3600e3; for (const [k, v] of docs) if (v.ts < lim) docs.delete(k); const n = Date.now(); for (const [k, v] of codes) if (v < n) codes.delete(k); for (const [k, v] of sessions) if (v < n) sessions.delete(k); tries.clear(); }, 600e3);
setInterval(() => { wss.clients.forEach(c => { c.cnt = 0; }); }, 1000);

server.listen(PORT, () => console.log('listening on', PORT));
