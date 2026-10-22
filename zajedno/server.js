"use strict";
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DEV = process.env.DEV_LOGIN === "1";
const ALLOWED = (process.env.ALLOWED_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_MEMBERS = 12;

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
app.get("/config", (req, res) => res.json({ clientId: CLIENT_ID, dev: DEV, iceServers: iceServers() }));

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
    res.json(issue({ id: p.sub, name: String(p.name || p.email).slice(0, 40), picture: p.picture || "", email: p.email }));
  } catch (e) {
    res.status(401).json({ error: "Google prijava nije uspjela." });
  }
});
if (DEV) {
  app.post("/auth/dev", (req, res) => {
    const name = String((req.body && req.body.name) || "").trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: "Upišite ime." });
    res.json(issue({ id: "dev-" + crypto.createHash("sha1").update(name).digest("hex").slice(0, 10), name, picture: "", email: "" }));
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
  if (!v.url) return { url: "", title: "", t: 0, playing: false };
  const t = v.playing ? v.t + (Date.now() - v.at) / 1000 : v.t;
  return { url: v.url, title: v.title, t, playing: v.playing };
}

io.use((socket, next) => {
  const p = verify(socket.handshake.auth && socket.handshake.auth.token);
  if (!p) return next(new Error("unauthorized"));
  socket.user = { id: p.id, name: p.name, picture: p.picture || "" };
  next();
});

io.on("connection", socket => {
  let code = "";
  let lastChat = 0;
  socket.emit("hello", socket.user);

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
    ack({ code, me: { ...socket.user, sid: socket.id }, members: memberList(r), chat: r.chat, video: videoNow(r) });
    socket.to(code).emit("members", memberList(r));
  }

  socket.on("create", (_, ack) => {
    if (typeof ack !== "function") return;
    const c = newCode();
    const r = { code: c, members: new Map(), chat: [], video: { url: "", title: "", t: 0, playing: false, at: 0 }, emptySince: Date.now() };
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

  socket.on("video:set", d => {
    const r = rooms.get(code); if (!r) return;
    const url = String((d && d.url) || "").trim();
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return;
    r.video = { url, title: String((d && d.title) || "").slice(0, 100), t: 0, playing: false, at: Date.now() };
    io.to(code).emit("video:set", videoNow(r));
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
