"use strict";
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");
const catalog = require("./catalog");
const store = require("./store");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DEV = process.env.DEV_LOGIN === "1";
const ALLOWED = (process.env.ALLOWED_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const ADMINS = new Set((process.env.ADMIN_EMAILS || "").split(/[,;\s]+/).map(s => s.trim().replace(/^["']+|["']+$/g, "").toLowerCase()).filter(Boolean));
console.log("Admin emailova: " + ADMINS.size + (ADMINS.size ? " (" + [...ADMINS].map(e => e.replace(/^(.).*(@.*)$/, "$1***$2")).join(", ") + ")" : " (ADMIN_EMAILS nije postavljen)"));
if (DEV) ADMINS.add("dev-admin@local"); // u razvojnom načinu je admin svako ime koje počinje sa "admin"
const isAdminEmail = e => !!e && ADMINS.has(String(e).toLowerCase());
const MAX_MEMBERS = 12;
const YT_KEY = process.env.YOUTUBE_API_KEY || "";

if (!process.env.SESSION_SECRET) {
  console.warn("UPOZORENJE: SESSION_SECRET nije postavljen. Prijave će isteći pri svakom restartu servera.");
}
if (!CLIENT_ID && !DEV) {
  console.warn("UPOZORENJE: GOOGLE_CLIENT_ID nije postavljen, prijava preko Googlea neće raditi.");
}

/* ---------- potpisani session token (bez baze) ---------- */
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  return b + "." + s;
}
function verify(token) {
  if (typeof token !== "string") return null;
  const [b, s] = token.split(".");
  if (!b || !s) return null;
  const e = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  const A = Buffer.from(s), B = Buffer.from(e);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function issue(user) {
  return { token: sign({ ...user, exp: Date.now() + SESSION_MS }), user };
}

/* ---------- HTTP ---------- */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });
app.use(express.static(path.join(__dirname, "public")));

function iceServers() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    list.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
  }
  return list;
}
app.get("/config", (req, res) => res.json({ clientId: CLIENT_ID, dev: DEV, iceServers: iceServers(), searchYT: !!YT_KEY }));

/* YouTube pretraga: ključ ostaje na serveru, dozvoljeno samo prijavljenima, 10 pretraga u minuti po osobi */
const searchHits = new Map();
app.get("/search", async (req, res) => {
  const p = verify(String(req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!p) return res.status(401).json({ error: "Niste prijavljeni." });
  if (!YT_KEY) return res.status(501).json({ error: "YouTube pretraga nije podešena na serveru (YOUTUBE_API_KEY). Koristite Internet Archive ili zalijepite link." });
  const now = Date.now();
  const hits = (searchHits.get(p.id) || []).filter(t => now - t < 60000);
  if (hits.length >= 10) return res.status(429).json({ error: "Previše pretraga, pričekajte minutu." });
  hits.push(now); searchHits.set(p.id, hits);
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.json({ items: [] });
  try {
    const u = new URL("https://www.googleapis.com/youtube/v3/search");
    u.searchParams.set("part", "snippet");
    u.searchParams.set("type", "video");
    u.searchParams.set("videoEmbeddable", "true");
    u.searchParams.set("maxResults", "12");
    u.searchParams.set("safeSearch", "moderate");
    if (req.query.long === "1") u.searchParams.set("videoDuration", "long");
    u.searchParams.set("q", q);
    u.searchParams.set("key", YT_KEY);
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: "YouTube: " + ((j.error && j.error.message) || "greška") });
    const items = (j.items || []).filter(i => i.id && /^[\w-]{11}$/.test(i.id.videoId || "")).map(i => ({
      id: i.id.videoId,
      title: String(i.snippet.title || "").slice(0, 120),
      channel: String(i.snippet.channelTitle || "").slice(0, 60),
      thumb: "https://i.ytimg.com/vi/" + i.id.videoId + "/mqdefault.jpg"
    }));
    res.json({ items });
  } catch (e) {
    res.status(502).json({ error: "YouTube pretraga nije uspjela." });
  }
});

/* ---------- katalog filmova ---------- */
const userFrom = p => ({ id: p.id, name: p.name, picture: p.picture || "", admin: isAdminEmail(p.email) });
function needUser(req, res, next) {
  const p = verify(String(req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!p) return res.status(401).json({ error: "Niste prijavljeni." });
  req.user = userFrom(p);
  next();
}
function needAdmin(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: "Samo administrator može mijenjati filmove." });
  next();
}
let films = [], loaded = false, loading = null;
// Katalog se učitava iz pohrane. Ako pohrana nije dostupna, popis ostaje neučitan (ne prepisujemo ga primjerima)
// i učitavanje se pokušava ponovo pri sljedećem zahtjevu.
function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const saved = await store.load();
      if (saved === null) { films = catalog.seed(); await store.save(films); } else films = saved;
      loaded = true;
      console.log("Katalog: " + films.length + " filmova (pohrana: " + store.kind + ")");
    })().finally(() => { loading = null; });
  }
  return loading;
}
const ready = ensureLoaded().catch(e => console.error("Katalog se nije mogao učitati: " + e.message + " (pokušat ću ponovo)"));
let lock = Promise.resolve();
function mutate(fn) { // izmjene idu jedna po jedna; popis se mijenja tek kad je spremanje uspjelo
  const run = lock.then(async () => { await ready; await ensureLoaded(); const res = fn(films); await store.save(res.list); films = res.list; return res.film; });
  lock = run.catch(() => {});
  return run;
}
function fail(res, e) {
  if (e instanceof catalog.ValidationError) return res.status(400).json({ error: e.message });
  if (e instanceof catalog.NotFoundError) return res.status(404).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: "Spremanje nije uspjelo, pokušajte ponovo." });
}
app.get("/api/me", needUser, (req, res) => res.json(req.user));
app.get("/api/films", needUser, async (req, res) => {
  try { await ready; await ensureLoaded(); } catch (e) { return res.status(503).json({ error: "Pohrana filmova trenutno nije dostupna, pokušajte za koji trenutak." }); }
  res.json({ films, storage: store.kind });
});
app.post("/api/films", needUser, needAdmin, async (req, res) => {
  try { const film = await mutate(l => catalog.create(l, req.body)); io.emit("films:changed"); res.json({ film }); } catch (e) { fail(res, e); }
});
app.put("/api/films/:id", needUser, needAdmin, async (req, res) => {
  try { const film = await mutate(l => catalog.update(l, String(req.params.id), req.body)); io.emit("films:changed"); res.json({ film }); } catch (e) { fail(res, e); }
});
app.delete("/api/films/:id", needUser, needAdmin, async (req, res) => {
  try { const film = await mutate(l => catalog.remove(l, String(req.params.id))); io.emit("films:changed"); res.json({ film }); } catch (e) { fail(res, e); }
});

const oauth = new OAuth2Client(CLIENT_ID || undefined);
app.post("/auth/google", async (req, res) => {
  try {
    if (!CLIENT_ID) return res.status(500).json({ error: "Server nema podešen GOOGLE_CLIENT_ID." });
    const cred = req.body && req.body.credential;
    if (typeof cred !== "string") return res.status(400).json({ error: "Nedostaje podatak za prijavu." });
    const ticket = await oauth.verifyIdToken({ idToken: cred, audience: CLIENT_ID });
    const p = ticket.getPayload();
    if (!p || !p.sub || !p.email_verified) return res.status(401).json({ error: "Google email nije potvrđen." });
    if (ALLOWED.length && !ALLOWED.includes(String(p.email).toLowerCase())) {
      return res.status(403).json({ error: "Ovaj email nema pristup." });
    }
    console.log("Prijava: " + String(p.email).replace(/^(.).*(@.*)$/, "$1***$2") + " admin=" + isAdminEmail(p.email));
    res.json(issue({ id: p.sub, name: String(p.name || p.email).slice(0, 40), picture: p.picture || "", email: p.email }));
  } catch (e) {
    res.status(401).json({ error: "Google prijava nije uspjela." });
  }
});
if (DEV) {
  app.post("/auth/dev", (req, res) => {
    const name = String((req.body && req.body.name) || "").trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: "Upišite ime." });
    res.json(issue({ id: "dev-" + crypto.createHash("sha1").update(name).digest("hex").slice(0, 10), name, picture: "", email: /^admin/i.test(name) ? "dev-admin@local" : "dev@local" }));
  });
}

/* ---------- Socket.IO ---------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

const rooms = new Map(); // code -> {code, members: Map(sid -> m), chat: [], video, emptySince}
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanCode(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); }
function memberList(r) {
  return [...r.members.entries()].map(([sid, m]) => ({ sid, id: m.id, name: m.name, picture: m.picture, mic: m.mic }));
}
function videoNow(r) {
  const v = r.video;
  if (!v.url) return { type: "", id: "", url: "", title: "", t: 0, playing: false };
  const t = v.playing ? v.t + (Date.now() - v.at) / 1000 : v.t;
  return { type: v.type || "file", id: v.id || "", url: v.url, title: v.title, t, playing: v.playing };
}

io.use((socket, next) => {
  const p = verify(socket.handshake.auth && socket.handshake.auth.token);
  if (!p) return next(new Error("unauthorized"));
  socket.user = userFrom(p);
  next();
});

const lobbyChat = []; // opšti chat, vide ga svi prijavljeni
io.on("connection", socket => {
  let code = "";
  let lastChat = 0;
  socket.emit("hello", socket.user);
  socket.join("lobby");
  socket.emit("lobby:history", lobbyChat);

  function leave() {
    if (!code) return;
    const r = rooms.get(code);
    socket.leave(code);
    if (r) {
      r.members.delete(socket.id);
      socket.to(code).emit("rtc:bye", { from: socket.id });
      io.to(code).emit("members", memberList(r));
      if (!r.members.size) r.emptySince = Date.now();
    }
    code = "";
  }
  function enter(r, ack) {
    if (r.members.size >= MAX_MEMBERS) return ack({ error: "Soba je puna." });
    leave();
    code = r.code;
    r.emptySince = 0;
    r.members.set(socket.id, { ...socket.user, mic: false });
    socket.join(code);
    ack({ code, me: { ...socket.user, sid: socket.id }, members: memberList(r), chat: r.chat, video: videoNow(r), film: r.film || null });
    socket.to(code).emit("members", memberList(r));
  }

  socket.on("create", async (d, ack) => {
    if (typeof ack !== "function") return;
    // soba može nastati iz filma: tada se odmah pušta trailer (ili cijeli film, ako ga je admin dodao)
    let film = null;
    if (d && d.filmId) {
      try { await ready; await ensureLoaded(); } catch (e) { return ack({ error: "Katalog trenutno nije dostupan, pokušajte ponovo." }); }
      film = films.find(f => f.id === String(d.filmId));
      if (!film) return ack({ error: "Taj film više ne postoji." });
    }
    const c = newCode();
    const r = { code: c, members: new Map(), chat: [], film: film ? { id: film.id, title: film.title } : null,
      video: { url: "", title: "", t: 0, playing: false, at: 0 }, emptySince: Date.now() };
    if (film) {
      const g = catalog.groupVideo(film);
      r.video = { type: g.type, id: g.id || "", url: g.url, title: g.title, t: 0, playing: false, at: Date.now() };
    }
    rooms.set(c, r);
    enter(r, ack);
  });
  socket.on("join", (d, ack) => {
    if (typeof ack !== "function") return;
    const r = rooms.get(cleanCode(d && d.code));
    if (!r) return ack({ error: "Soba ne postoji ili je istekla." });
    enter(r, ack);
  });
  socket.on("leave", leave);

  socket.on("chat", d => {
    const r = rooms.get(code); if (!r) return;
    const text = String((d && d.text) || "").trim().slice(0, 300);
    const now = Date.now();
    if (!text || now - lastChat < 200) return;
    lastChat = now;
    const msg = { id: now + "-" + socket.id, uid: socket.user.id, name: socket.user.name, picture: socket.user.picture, text, ts: now };
    r.chat.push(msg);
    if (r.chat.length > 200) r.chat.shift();
    io.to(code).emit("chat", msg);
  });
  socket.on("lobby:chat", d => {
    const text = String((d && d.text) || "").trim().slice(0, 300);
    const now = Date.now();
    if (!text || now - lastChat < 200) return;
    lastChat = now;
    const msg = { id: now + "-" + socket.id, uid: socket.user.id, name: socket.user.name, picture: socket.user.picture, text, ts: now };
    lobbyChat.push(msg);
    if (lobbyChat.length > 100) lobbyChat.shift();
    io.to("lobby").emit("lobby:chat", msg);
  });

  socket.on("video:set", d => {
    const r = rooms.get(code); if (!r) return;
    const title = String((d && d.title) || "").slice(0, 100);
    let vid;
    if (d && d.type === "yt") {
      const id = String(d.id || "");
      if (!/^[\w-]{11}$/.test(id)) return;
      vid = { type: "yt", id, url: "https://www.youtube.com/watch?v=" + id };
    } else {
      vid = catalog.parseMedia(String((d && d.url) || "").slice(0, 3000)); // link ili zalijepljen iframe kod
      if (!vid || vid.url.length > 2000) return;
    }
    r.video = { ...vid, title, t: 0, playing: false, at: Date.now() };
    io.to(code).emit("video:set", videoNow(r));
  });
  let lastCount = 0;
  socket.on("countdown", d => { // "Pokreni za sve" / "Pauziraj sve" za embedove koji se ne mogu sinhronizirati
    const r = rooms.get(code); if (!r) return;
    const now = Date.now(); if (now - lastCount < 4000) return; lastCount = now;
    io.to(code).emit("countdown", { kind: d && d.kind === "pause" ? "pause" : "play", by: socket.user.name });
  });
  socket.on("video:sync", (d, ack) => { // klijent traži trenutno stanje (ručno ili automatska provjera odstupanja)
    const r = rooms.get(code); if (typeof ack !== "function") return;
    ack(r && r.video && (r.video.url || r.video.id) ? videoNow(r) : null);
  });
  socket.on("video:state", d => {
    const r = rooms.get(code); if (!r || !r.video.url) return;
    const t = Number(d && d.t);
    if (!Number.isFinite(t) || t < 0) return;
    r.video.t = t; r.video.playing = !!(d && d.playing); r.video.at = Date.now();
    socket.to(code).emit("video:state", { playing: r.video.playing, t });
  });

  socket.on("mic", on => {
    const r = rooms.get(code); if (!r) return;
    const m = r.members.get(socket.id); if (!m) return;
    m.mic = !!on;
    io.to(code).emit("members", memberList(r));
  });

  /* WebRTC signalizacija: server samo prosljeđuje poruke članovima iste sobe */
  socket.on("rtc:hi", () => { if (code) socket.to(code).emit("rtc:hi", { from: socket.id }); });
  socket.on("rtc:bye", () => { if (code) socket.to(code).emit("rtc:bye", { from: socket.id }); });
  socket.on("rtc", d => {
    const r = rooms.get(code); if (!r || !d || !r.members.has(d.to)) return;
    io.to(d.to).emit("rtc", { from: socket.id, data: d.data });
  });

  socket.on("disconnect", leave);
});

setInterval(() => {
  const limit = Date.now() - 6 * 3600 * 1000;
  for (const [c, r] of rooms) if (!r.members.size && r.emptySince && r.emptySince < limit) rooms.delete(c);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log("Zajedno radi na portu " + PORT));
