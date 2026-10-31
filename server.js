'use strict';
// Table Companion party server.
// The host runs this on their own PC. Friends open the website (or the host's link)
// and connect to this server. No dependencies: only Node's built-in modules.
//
//   node server.js            serve on this PC only (http://localhost:3000)
//   set PORT=3001             use another port
//   set NO_OPEN=1             do not open the browser automatically
//   set TUNNEL=0              do not try to open a public link automatically
//   set PUBLIC_URL=https://x  use your own public https address instead of a tunnel
//   set SITE_URL=https://...  the web page your friends use (default: the GitHub site)
//   set ORIGINS=a,b           extra web addresses allowed to talk to this server

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

// ---- logs: logs/server-log.txt has everything, logs/errors-log.txt only warnings and errors ----
const LOGDIR = path.join(__dirname, 'logs');
const LOGMAX = 2 * 1024 * 1024;
try {
  fs.mkdirSync(LOGDIR, { recursive: true });
  fs.writeFileSync(path.join(LOGDIR, '.gitignore'), '*\n'); // never commit logs to GitHub
  for (const f of ['server-log.txt', 'errors-log.txt']) {
    try { if (fs.statSync(path.join(LOGDIR, f)).size > LOGMAX) fs.renameSync(path.join(LOGDIR, f), path.join(LOGDIR, f + '.old')); } catch (e) { /* no file yet */ }
  }
} catch (e) { /* logging is best effort */ }
function log(level, msg) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + level.padEnd(5) + ' ' + String(msg).replace(/\r?\n/g, ' | ');
  try {
    fs.appendFileSync(path.join(LOGDIR, 'server-log.txt'), line + '\n');
    if (level !== 'INFO') fs.appendFileSync(path.join(LOGDIR, 'errors-log.txt'), line + '\n');
  } catch (e) { /* ignore */ }
}
const logI = m => log('INFO', m), logW = m => log('WARN', m), logE = m => log('ERROR', m);
process.on('uncaughtException', e => { logE('Crash: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', e => logE('Unhandled error: ' + (e && e.stack || e)));

const PORT = Number(process.env.PORT) || 3000;
const SITE = process.env.SITE_URL || 'https://firejason75.github.io/DnD-Companion/';
const AL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAXP = 8;
const SIDES = [4, 6, 8, 10, 12, 20, 100];
const HOLD = 25000; // how long a live-update request waits for news (ms)

let siteOrigin = '';
try { siteOrigin = new URL(SITE).origin; } catch (e) { /* bad SITE_URL */ }
const ORIGINS = new Set([siteOrigin, ...(process.env.ORIGINS || '').split(',').map(s => s.trim())].filter(Boolean));

const rnd = n => crypto.randomInt(n);
const mkCode = () => Array.from({ length: 5 }, () => AL[rnd(AL.length)]).join('');
const tok = () => crypto.randomBytes(24).toString('base64url');
const hex = n => crypto.randomBytes(n).toString('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cl = (s, n) => String(s == null ? '' : s).slice(0, n);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));
const arr = a => (Array.isArray(a) ? a : []);
const okUrl = u => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(u);
const info = m => ({
  name: cl(m && m.name, 30).trim() || 'Adventurer',
  cls: cl(m && m.cls, 30),
  lvl: num(m && m.lvl, 1, 20),
  hp: num(m && m.hp, -999, 9999),
  max: num(m && m.max, 0, 9999),
  ac: num(m && m.ac, 0, 99),
});

// ---- party state (kept in memory while this program runs) ----
let code = mkCode();
const hostKey = tok();
const players = new Map();   // session token -> player
const removed = new Map();   // session token -> { reason, at } so a removed player is told why
let shared = { who: 'DM', round: 1, turn: 0, init: [], quests: [], notes: [] };
let feed = [];
let publicUrl = okUrl(String(process.env.PUBLIC_URL || '').replace(/\/+$/, '')) ? String(process.env.PUBLIC_URL).replace(/\/+$/, '') : '';
let ver = 1;
const hostWaiters = new Set();
const fails = [];

function snap(isHost) {
  const roster = [...players.values()].map(p => {
    const r = { name: p.name, cls: p.cls, lvl: p.lvl, hp: p.hp, max: p.max, ac: p.ac, on: p.on };
    if (isHost) r.id = p.id;
    return r;
  });
  const f = feed.filter(x => isHost || !x.hid).slice(0, 30).map(x => (isHost ? x : { w: x.w, t: x.t }));
  const s = { code, round: shared.round, turn: shared.turn, init: shared.init, roster, quests: shared.quests, notes: shared.notes, feed: f };
  if (isHost) { s.site = SITE; s.publicUrl = publicUrl; }
  return s;
}

// ---- live updates by long-polling (works through any tunnel, unlike streaming) ----
let queued = false;
function flush() {
  const fp = snap(false), fh = snap(true);
  for (const p of players.values()) {
    const w = p.wait;
    if (w && w.v < ver) { clearTimeout(w.t); p.wait = null; json(w.res, 200, { v: ver, state: fp }); }
  }
  for (const w of [...hostWaiters]) {
    if (w.v < ver) { clearTimeout(w.t); hostWaiters.delete(w); json(w.res, 200, { v: ver, state: fh }); }
  }
}
function changed() {
  ver++;
  if (queued) return;
  queued = true;
  setImmediate(() => { queued = false; flush(); });
}

function addRoll(who, b, hid) {
  const n = num(b.n || 1, 1, 20);
  const s = SIDES.includes(+b.s) ? +b.s : 20;
  const m = num(b.m, -99, 99);
  const k = b.k === 'a' || b.k === 'd' ? b.k : 'n';
  const two = k !== 'n' && s === 20;
  const rs = Array.from({ length: two ? 2 : n }, () => crypto.randomInt(1, s + 1));
  let total, detail, label;
  if (two) {
    const p = k === 'a' ? Math.max(...rs) : Math.min(...rs);
    total = p + m; detail = rs.join(', ') + ' → ' + p; label = 'd20 ' + (k === 'a' ? 'advantage' : 'disadvantage');
  } else {
    total = rs.reduce((a, c) => a + c, 0) + m; detail = rs.join(' + '); label = n + 'd' + s;
  }
  feed.unshift({ w: cl(who, 30) || 'Someone', t: label + (m ? (m > 0 ? '+' : '') + m : '') + ': ' + total + ' (' + detail + ')', hid: !!hid });
  feed.length = Math.min(feed.length, 30);
  changed();
}

// ---- http helpers ----
function json(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

function readBody(req, max) {
  return new Promise((ok, no) => {
    let n = 0, big = false;
    const c = [];
    req.on('data', d => { n += d.length; if (n > max) { big = true; return; } c.push(d); });
    req.on('end', () => {
      if (big) return no(Object.assign(new Error('That request is too large.'), { status: 413 }));
      try { ok(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')); }
      catch (e) { no(Object.assign(new Error('Bad request.'), { status: 400 })); }
    });
    req.on('error', no);
  });
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) return json(res, 500, { error: 'index.html was not found next to server.js.' });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// Only the website (and this server's own pages) may talk to the API from a browser.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.has(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}

function playerPoll(req, res, u) {
  const token = u.searchParams.get('token') || '';
  const p = players.get(token);
  if (!p) {
    const r = removed.get(token);
    if (r) { removed.delete(token); return json(res, 200, { kicked: r.reason }); }
    return json(res, 401, { error: 'Your session ended. Join again.' });
  }
  const v = num(u.searchParams.get('v'), 0, 1e9);
  p.seen = Date.now();
  if (!p.on) { p.on = true; changed(); }
  if (p.wait) { clearTimeout(p.wait.t); json(p.wait.res, 200, { v, same: true }); p.wait = null; }
  if (v < ver) return json(res, 200, { v: ver, state: snap(false) });
  const w = { res, v, t: setTimeout(() => { if (p.wait === w) { p.wait = null; p.seen = Date.now(); json(res, 200, { v, same: true }); } }, HOLD) };
  p.wait = w;
  res.on('close', () => { if (p.wait === w) { clearTimeout(w.t); p.wait = null; } });
}

function hostPoll(req, res, u) {
  if (!same(u.searchParams.get('key') || '', hostKey)) return json(res, 401, { error: 'Wrong host key.' });
  const v = num(u.searchParams.get('v'), 0, 1e9);
  if (v < ver) return json(res, 200, { v: ver, state: snap(true) });
  const w = { res, v, t: setTimeout(() => { hostWaiters.delete(w); json(res, 200, { v, same: true }); }, HOLD) };
  hostWaiters.add(w);
  res.on('close', () => { if (hostWaiters.delete(w)) clearTimeout(w.t); });
}

const needHost = (b, res) => {
  if (same(b.key || '', hostKey)) return true;
  json(res, 401, { error: 'Wrong host key.' });
  return false;
};
const needPlayer = (b, res) => {
  const p = players.get(String(b.token || ''));
  if (!p) json(res, 401, { error: 'Your session ended. Join again.' });
  return p;
};
// take a player out of the party; they are told why on their next poll
const drop = (p, reason) => {
  players.delete(p.token);
  logI('Player removed: ' + p.name + ' (' + reason + ')');
  removed.set(p.token, { reason, at: Date.now() });
  if (p.wait) { clearTimeout(p.wait.t); json(p.wait.res, 200, { kicked: reason }); p.wait = null; removed.delete(p.token); }
};

// ---- accounts: usernames and passwords live on the host's PC (data/accounts.json), passwords only as scrypt hashes ----
const DATA = path.join(__dirname, 'data');
const ACC_FILE = path.join(DATA, 'accounts.json');
const MAXACC = 100, MAXCHARS = 5, TOKEN_DAYS = 30;
let secret, accts = {};
try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, '.gitignore'), '*\n'); // never commit accounts to GitHub
  try { secret = fs.readFileSync(path.join(DATA, 'secret.key')); } catch (e) { secret = null; }
  if (!secret || secret.length < 32) { secret = crypto.randomBytes(32); fs.writeFileSync(path.join(DATA, 'secret.key'), secret); }
  try { accts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) || {}; } catch (e) { accts = {}; }
} catch (e) { secret = crypto.randomBytes(32); logE('Could not set up the data folder: ' + e.message); }
const saveAccts = () => {
  try { fs.writeFileSync(ACC_FILE + '.tmp', JSON.stringify(accts)); fs.renameSync(ACC_FILE + '.tmp', ACC_FILE); }
  catch (e) { logE('Could not save accounts: ' + e.message); }
};
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => e ? no(e) : ok(k)));
const mac = s => crypto.createHmac('sha256', secret).update(s).digest('base64url');
const mkToken = ln => { const exp = Date.now() + TOKEN_DAYS * 86400000; const b = ln + '.' + exp; return b + '.' + mac(b); };
function userFrom(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !same(parts[2], mac(parts[0] + '.' + parts[1]))) return null;
  if (!(+parts[1] > Date.now())) return null;
  return Object.prototype.hasOwnProperty.call(accts, parts[0]) ? accts[parts[0]] : null;
}
const sanChar = c => {
  c = c && typeof c === 'object' ? c : {};
  const ab = c.ab && typeof c.ab === 'object' ? c.ab : {}, A = {};
  for (const k of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) A[k] = num(ab[k] == null ? 10 : ab[k], 1, 30);
  return { name: cl(c.name, 30).trim() || 'Adventurer', cls: cl(c.cls, 30), lvl: num(c.lvl, 1, 20), ab: A,
    hp: num(c.hp, -999, 9999), max: num(c.max, 0, 9999), ac: num(c.ac, 0, 99), spd: num(c.spd, 0, 999),
    inv: cl(c.inv, 3000), spells: cl(c.spells, 3000) };
};
const loginFails = new Map(); // username -> recent failure times
const afails = [];            // all failed logins, for a global brake
const checkCode = (b, res) => {
  const now = Date.now();
  while (fails.length && now - fails[0] > 60000) fails.shift();
  if (fails.length >= 10) { json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' }); return false; }
  const c = cl(b.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!same(c, code)) { fails.push(now); json(res, 403, { error: 'Wrong party code.' }); return false; }
  return true;
};
const needAcct = (b, res) => {
  const u = userFrom(b.token);
  if (!u) json(res, 401, { error: 'Please log in again.' });
  return u;
};
const chars = u => u.chars.map(x => ({ id: x.id, c: x.c }));
const DUMMY = crypto.randomBytes(16);

const routes = {
  '/api/register': async (b, res) => {
    if (!checkCode(b, res)) return;
    const name = cl(b.user, 20).trim(), ln = name.toLowerCase(), pw = String(b.pass == null ? '' : b.pass);
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) return json(res, 400, { error: 'Username: 3 to 20 letters, numbers, - or _.' });
    if (pw.length < 8 || pw.length > 100) return json(res, 400, { error: 'Password must be 8 to 100 characters.' });
    if (Object.prototype.hasOwnProperty.call(accts, ln)) return json(res, 409, { error: 'That username is taken.' });
    if (Object.keys(accts).length >= MAXACC) return json(res, 409, { error: 'This host has reached its account limit.' });
    const salt = crypto.randomBytes(16), hash = await scrypt(pw, salt);
    if (Object.prototype.hasOwnProperty.call(accts, ln)) return json(res, 409, { error: 'That username is taken.' });
    accts[ln] = { name, salt: salt.toString('base64'), hash: hash.toString('base64'), chars: [], made: Date.now() };
    saveAccts();
    logI('Account created: ' + name);
    json(res, 200, { token: mkToken(ln), user: name });
  },
  '/api/login': async (b, res) => {
    if (!checkCode(b, res)) return;
    const now = Date.now(), ln = cl(b.user, 20).trim().toLowerCase(), pw = String(b.pass == null ? '' : b.pass).slice(0, 100);
    while (afails.length && now - afails[0] > 60000) afails.shift();
    const mine = (loginFails.get(ln) || []).filter(t => now - t < 300000);
    if (afails.length >= 30 || mine.length >= 5) return json(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
    const u = Object.prototype.hasOwnProperty.call(accts, ln) ? accts[ln] : null;
    const got = await scrypt(pw, u ? Buffer.from(u.salt, 'base64') : DUMMY);
    if (!u || !crypto.timingSafeEqual(got, Buffer.from(u.hash, 'base64'))) {
      mine.push(now); loginFails.set(ln, mine); afails.push(now);
      logW('Failed login for "' + ln.slice(0, 20) + '"');
      return json(res, 401, { error: 'Wrong username or password.' });
    }
    loginFails.delete(ln);
    logI('Login: ' + u.name);
    json(res, 200, { token: mkToken(ln), user: u.name, chars: chars(u) });
  },
  '/api/chars/list': (b, res) => {
    const u = needAcct(b, res); if (!u) return;
    json(res, 200, { user: u.name, chars: chars(u) });
  },
  '/api/chars/save': (b, res) => {
    const u = needAcct(b, res); if (!u) return;
    const c = sanChar(b.c), id = cl(b.id, 40), cur = id && u.chars.find(x => x.id === id);
    if (cur) cur.c = c;
    else {
      if (u.chars.length >= MAXCHARS) return json(res, 409, { error: 'You already have 5 characters. Delete one first.' });
      if (u.chars.some(x => x.c.name.toLowerCase() === c.name.toLowerCase())) return json(res, 409, { error: 'You already have a character with that name.' });
      u.chars.push({ id: hex(6), c });
    }
    saveAccts();
    json(res, 200, { id: cur ? cur.id : u.chars[u.chars.length - 1].id, chars: chars(u) });
  },
  '/api/chars/del': (b, res) => {
    const u = needAcct(b, res); if (!u) return;
    u.chars = u.chars.filter(x => x.id !== cl(b.id, 40));
    saveAccts();
    json(res, 200, { chars: chars(u) });
  },
  '/api/join': (b, res) => {
    const now = Date.now();
    while (fails.length && now - fails[0] > 60000) fails.shift();
    if (fails.length >= 10) return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    const c = cl(b.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!same(c, code)) { fails.push(now); return json(res, 403, { error: 'Wrong party code.' }); }
    if (b.check === true) return json(res, 200, { ok: true });
    const i = info(b);
    for (const [t, p] of players) {
      if (p.name.toLowerCase() === i.name.toLowerCase()) {
        if (p.on) return json(res, 409, { error: 'That name is already in the party. Pick a different character name.' });
        players.delete(t);
      }
    }
    if (players.size >= MAXP) return json(res, 409, { error: 'The party is full.' });
    const p = Object.assign({ id: hex(6), token: tok(), wait: null, last: 0, seen: now, on: true }, i);
    players.set(p.token, p);
    logI('Player joined: ' + p.name + ' (' + players.size + ' in party)');
    changed();
    json(res, 200, { token: p.token, id: p.id });
  },
  '/api/upd': (b, res) => {
    const p = needPlayer(b, res); if (!p) return;
    Object.assign(p, info(Object.assign({}, b, { name: p.name })));
    p.seen = Date.now();
    changed();
    json(res, 200, { ok: true });
  },
  '/api/roll': (b, res) => {
    const p = needPlayer(b, res); if (!p) return;
    const now = Date.now();
    if (now - p.last < 400) return json(res, 429, { error: 'Slow down a little.' });
    p.last = now;
    addRoll(p.name, b, false);
    json(res, 200, { ok: true });
  },
  '/api/leave': (b, res) => {
    const p = players.get(String(b.token || ''));
    if (p) { drop(p, 'left'); removed.delete(p.token); changed(); }
    json(res, 200, { ok: true });
  },
  '/api/host/state': (b, res) => {
    if (!needHost(b, res)) return;
    shared = {
      who: cl(b.who, 30) || 'DM',
      round: num(b.round, 1, 9999),
      turn: num(b.turn, 0, 999),
      init: arr(b.init).slice(0, 60).map(x => ({ n: cl(x && x.n, 40), i: num(x && x.i, -99, 99), down: !!(x && x.down) })),
      quests: arr(b.quests).slice(0, 60).map(x => ({ t: cl(x && x.t, 200), d: !!(x && x.d) })),
      notes: arr(b.notes).slice(0, 60).map(x => ({ t: cl(x && x.t, 100), b: cl(x && x.b, 3000) })),
    };
    changed();
    json(res, 200, { ok: true });
  },
  '/api/host/roll': (b, res) => {
    if (!needHost(b, res)) return;
    addRoll(cl(b.who, 30) || shared.who, b, !!b.hid);
    json(res, 200, { ok: true });
  },
  '/api/host/kick': (b, res) => {
    if (!needHost(b, res)) return;
    for (const p of [...players.values()]) if (p.id === String(b.id)) drop(p, 'kicked');
    changed();
    json(res, 200, { ok: true });
  },
  '/api/host/reset': (b, res) => {
    if (!needHost(b, res)) return;
    for (const p of [...players.values()]) drop(p, 'reset');
    feed = [];
    code = mkCode();
    console.log('\n  New party code: ' + code + '\n');
    logI('Host made a new party code');
    changed();
    json(res, 200, { ok: true });
  },
  '/api/host/public': (b, res) => {
    if (!needHost(b, res)) return;
    const u = cl(b.url, 200).trim().replace(/\/+$/, '');
    if (u && !okUrl(u)) return json(res, 400, { error: 'That must be an https link, like https://something.lhr.life' });
    publicUrl = u;
    logI('Host set public link: ' + (u || '(cleared)'));
    changed();
    json(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.on('finish', () => {
    let path_ = req.url.split('?')[0]; // never log the query: it holds keys and tokens
    const sc = res.statusCode;
    if (sc === 200 && /\/poll$/.test(path_)) return; // routine live-update polls would flood the log
    const line = req.method + ' ' + path_ + ' -> ' + sc + ' (' + (Date.now() - t0) + ' ms)' + (req.headers.origin ? ' from ' + req.headers.origin : '');
    if (sc >= 500) logE(line); else if (sc >= 400 && ![401, 404, 409].includes(sc)) logW(line); else logI(line);
  });
  try {
    const u = new URL(req.url, 'http://localhost');
    const api = u.pathname.startsWith('/api/');
    if (api) {
      const crossOk = cors(req, res);
      if (!sameOrigin(req) && !crossOk) return json(res, 403, { error: 'This web address is not allowed to use this server.' });
      if (u.pathname.startsWith('/api/host/') && !sameOrigin(req)) return json(res, 403, { error: 'Host controls only work from the host page.' });
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    if (req.method === 'GET') {
      if (u.pathname === '/' || u.pathname === '/index.html') return page(res);
      if (u.pathname === '/api/ping') return json(res, 200, { ok: true, v: 2 });
      if (u.pathname === '/api/poll') return playerPoll(req, res, u);
      if (u.pathname === '/api/host/poll') return hostPoll(req, res, u);
      if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'POST') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send JSON.' });
      const fn = routes[u.pathname];
      if (!fn) return json(res, 404, { error: 'Not found.' });
      const b = await readBody(req, u.pathname.startsWith('/api/host/') ? 400000 : 10000);
      await fn(b && typeof b === 'object' ? b : {}, res);
      return;
    }
    json(res, 405, { error: 'Not allowed.' });
  } catch (e) {
    if (!e.status || e.status >= 500) logE('Request failed: ' + (e && e.stack || e));
    json(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});

// mark players offline when they stop polling; forget long-gone players and old notices
setInterval(() => {
  const now = Date.now();
  let any = false;
  for (const [t, p] of players) {
    const on = !!p.wait || now - p.seen < 40000;
    if (on !== p.on) { p.on = on; any = true; }
    if (!on && now - p.seen > 3 * 3600 * 1000) { players.delete(t); any = true; }
  }
  for (const [t, r] of removed) if (now - r.at > 600000) removed.delete(t);
  if (any) changed();
}, 5000).unref();

// ---- optional: open a free public link so friends can reach this PC ----
// Tries, in order: the ssh that already ships with Windows 10/11 (localhost.run, nothing to install),
// then cloudflared if the host happens to have it. Otherwise the host can paste any https link.
let tunnelProc = null;
const stopTunnel = () => { try { tunnelProc && tunnelProc.kill(); } catch (e) { /* already gone */ } };
process.on('exit', () => { logI('Server stopped'); stopTunnel(); });
process.on('SIGINT', () => { stopTunnel(); process.exit(0); });

const TUNNELS = [
  { name: 'ssh (localhost.run)', cmd: 'ssh',
    args: () => ['-T', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=30', '-R', '80:127.0.0.1:' + PORT, 'nokey@localhost.run'],
    find: t => {
      const c = t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const re = /(?:https?:\/\/)?([a-z0-9][a-z0-9-]*)\.(?:lhr\.life|localhost\.run)\b/gi;
      let m;
      while ((m = re.exec(c))) if (!/^(admin|docs|www|nokey)$/i.test(m[1])) return 'https://' + m[0].replace(/^https?:\/\//i, '').toLowerCase();
      return null;
    } },
  { name: 'ssh (pinggy)', cmd: 'ssh',
    args: () => ['-T', '-p', '443', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=30', '-R', '0:127.0.0.1:' + PORT, 'free.pinggy.io'],
    find: t => { const m = t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pinggy\.(?:link|io)\b/i); return m && !/\/\/(dashboard|www|free|a)\./i.test(m[0]) ? m[0] : null; } },
  { name: 'ssh (serveo)', cmd: 'ssh',
    args: () => ['-T', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=30', '-R', '80:127.0.0.1:' + PORT, 'serveo.net'],
    find: t => { const m = t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').match(/https:\/\/[a-z0-9-]+\.serveo(?:usercontent)?\.(?:net|com)\b/i); return m && m[0]; } },
  { name: 'cloudflared', cmd: 'cloudflared',
    args: () => ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + PORT],
    find: t => { const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); return m && m[0]; } },
];

function startTunnel(i) {
  i = i || 0;
  if (process.env.TUNNEL === '0' || publicUrl) return;
  if (i >= TUNNELS.length) {
    logE('No public link: every tunnel option failed');
    console.log('  Could not open a public link automatically (no internet, or ssh is blocked).');
    console.log('  Friends on your own Wi-Fi/network are not covered either. You can paste any https tunnel link on your host page.\n');
    return;
  }
  const t = TUNNELS[i];
  let p, found = false, moved = false, buf = '';
  const next = why => {
    if (moved) return; moved = true;
    const clean = buf.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).filter(l => l.trim() && !/[\u2580-\u259f]/.test(l) && !/^\s*$/.test(l));
    logW(t.name + ' did not work' + (why ? ': ' + why : '') + (clean.length ? ' | output: ' + clean.slice(-8).join(' / ') : ''));
    console.log('  ' + t.name + ' did not work' + (why ? ': ' + why : '') + (buf.trim() ? '\n    ' + buf.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).filter(l => l.trim() && !/[\u2580-\u259f]/.test(l)).slice(-8).join('\n    ') : ''));
    startTunnel(i + 1);
  };
  logI('Trying ' + t.name);
  try { p = spawn(t.cmd, t.args(), { windowsHide: true }); } catch (e) { return next(e.message); }
  tunnelProc = p;
  const scan = d => {
    const shown = String(d).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).filter(l => l.trim() && !/[\u2580-\u259f]/.test(l)).join(' / ');
    if (shown) logI('[' + t.name + '] ' + shown);
    if (found) return;
    const chunk = String(d);
    buf = (buf + chunk).slice(-60000);
    const u = t.find(chunk) || t.find(buf);
    if (u) {
      found = true; publicUrl = u; changed();
      logI('Public link is up via ' + t.name + ': ' + publicUrl);
      console.log('  Public link is up (' + t.name + '): ' + publicUrl);
      console.log('  Invite link for friends (also shown on your host page):');
      console.log('  ' + SITE + '#s=' + encodeURIComponent(publicUrl) + '&c=' + code + '\n');
    }
  };
  p.stdout.on('data', scan);
  p.stderr.on('data', scan);
  p.on('error', e => next(e.code === 'ENOENT' ? 'not installed' : e.message));
  p.on('exit', c => {
    if (found) { publicUrl = ''; changed(); logW('The public link stopped (' + t.name + ', code ' + c + ')'); console.log('  The public link stopped. Restart start.bat for a new one.\n'); }
    else next('it stopped (code ' + (c == null ? '?' : c) + ')');
  });
  setTimeout(() => { if (!found && !moved) { next('no link after 20 seconds'); try { p.kill(); } catch (e) { /* gone */ } } }, 20000).unref();
}

server.on('error', e => {
  logE('Server error: ' + (e.code || '') + ' ' + e.message);
  if (e.code === 'EADDRINUSE') console.error('\n  Port ' + PORT + ' is already in use. Close the other server window, or run with a different port (set PORT=3001).\n');
  else console.error('\n  Server error: ' + e.message + '\n');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const hostUrl = 'http://localhost:' + PORT + '/?host=' + hostKey;
  logI('Server started on port ' + PORT + ' (node ' + process.version + ', ' + process.platform + '); host link not logged on purpose');
  console.log('\n  D&D party server is running.\n');
  console.log('  Party code:  ' + code);
  console.log('  Your host link (keep it private, it controls the party):');
  console.log('  ' + hostUrl + '\n');
  console.log('  Closing this window ends the party.\n');
  console.log('  Logs: ' + LOGDIR + '  (server-log.txt = everything, errors-log.txt = warnings and errors)\n');
  if (publicUrl) {
    console.log('  Invite link for friends:');
    console.log('  ' + SITE + '#s=' + encodeURIComponent(publicUrl) + '&c=' + code + '\n');
  } else startTunnel(0);
  if (process.platform === 'win32' && process.env.NO_OPEN !== '1') exec('start "" "' + hostUrl + '"');
});
