// Pokretanje: DEV_LOGIN=1 SESSION_SECRET=test node server.js &  zatim: node test.js
const { io } = require("socket.io-client");
const BASE = process.env.BASE || "http://localhost:3111";
const assert = require("assert");

async function login(name) {
  const r = await fetch(BASE + "/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  return (await r.json()).token;
}
function client(token) {
  return new Promise((res, rej) => {
    const s = io(BASE, { auth: { token }, transports: ["websocket"] });
    s.once("hello", () => res(s));
    s.once("connect_error", rej);
  });
}
const once = (s, ev) => new Promise(r => s.once(ev, r));
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));

(async () => {
  // loš token se odbija
  await assert.rejects(client("lazni.token"), /unauthorized/);

  const a = await client(await login("Amra"));
  const b = await client(await login("Kenan"));

  const created = await emit(a, "create", {});
  assert.ok(/^[A-Z0-9]{6}$/.test(created.code), "kod sobe");
  assert.strictEqual(created.members.length, 1);

  const membersSeen = once(a, "members");
  const joined = await emit(b, "join", { code: created.code.toLowerCase() });
  assert.strictEqual(joined.members.length, 2, "b vidi oba člana");
  assert.strictEqual((await membersSeen).length, 2, "a vidi oba člana");

  // chat: obojica dobiju poruku
  const ma = once(a, "chat"), mb = once(b, "chat");
  a.emit("chat", { text: "Zdravo!" });
  assert.strictEqual((await ma).text, "Zdravo!");
  assert.strictEqual((await mb).name, "Amra");

  // video: postavljanje za sve i sinhronizacija
  const va = once(a, "video:set"), vb = once(b, "video:set");
  b.emit("video:set", { url: "https://example.com/film.mp4", title: "Film" });
  assert.strictEqual((await va).url, "https://example.com/film.mp4");
  await vb;
  const st = once(a, "video:state");
  b.emit("video:state", { playing: true, t: 42 });
  const s = await st; assert.strictEqual(s.playing, true); assert.strictEqual(s.t, 42);

  // nevažeći URL se ignoriše
  let bad = false; a.once("video:set", () => { bad = true; });
  b.emit("video:set", { url: "javascript:alert(1)" });
  await new Promise(r => setTimeout(r, 200)); assert.strictEqual(bad, false);

  // kasniji član dobija historiju i stanje videa
  const c = await client(await login("Tarik"));
  const j3 = await emit(c, "join", { code: created.code });
  assert.strictEqual(j3.chat.length, 1, "historija chata");
  assert.strictEqual(j3.video.url, "https://example.com/film.mp4");
  assert.ok(j3.video.playing && j3.video.t >= 42, "stanje videa");

  // WebRTC signalizacija
  const hi = once(b, "rtc:hi"); a.emit("rtc:hi"); assert.strictEqual((await hi).from, a.id);
  const rt = once(b, "rtc"); a.emit("rtc", { to: b.id, data: { k: "offer" } });
  const got = await rt; assert.strictEqual(got.from, a.id); assert.strictEqual(got.data.k, "offer");

  // drugi ne može slati signal u tuđu sobu
  const outsider = await client(await login("Strani"));
  let leaked = false; b.once("rtc", () => { leaked = true; });
  outsider.emit("rtc", { to: b.id, data: { k: "offer" } });
  await new Promise(r => setTimeout(r, 200)); assert.strictEqual(leaked, false);

  // mikrofon status se vidi svima
  const mic = once(a, "members"); b.emit("mic", true);
  assert.strictEqual((await mic).find(m => m.sid === b.id).mic, true);

  // izlazak
  const left = once(a, "members"); c.emit("leave");
  assert.strictEqual((await left).length, 2);

  console.log("SVI TESTOVI PROŠLI");
  process.exit(0);
})().catch(e => { console.error("TEST NIJE PROŠAO:", e); process.exit(1); });
