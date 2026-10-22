"use strict";
// Trajna pohrana kataloga. Ako su postavljene UPSTASH_REDIS_REST_URL i UPSTASH_REDIS_REST_TOKEN, koristi se
// besplatna Upstash Redis baza (preživi restart i novi deploy). Inače se piše u datoteku (DATA_DIR/films.json).
const fs = require("fs");
const path = require("path");

const KEY = "zajedno:films";
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DIR, "films.json");

async function redis(cmd) {
  const r = await fetch(UP_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + UP_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Upstash: " + (j.error || r.status));
  return j.result;
}

const kind = UP_URL && UP_TOKEN ? "upstash" : "datoteka";

// vraća niz filmova ili null ako još ništa nije spremljeno
async function load() {
  if (kind === "upstash") {
    const v = await redis(["GET", KEY]);
    return v ? JSON.parse(v) : null;
  }
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; } // oštećena datoteka ne smije se tiho prepisati primjerima
}
async function save(films) {
  const text = JSON.stringify(films);
  if (kind === "upstash") { await redis(["SET", KEY, text]); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, FILE);
}

module.exports = { load, save, kind };
