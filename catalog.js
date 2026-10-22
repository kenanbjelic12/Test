"use strict";
// Logika kataloga filmova: provjera unosa i izmjene popisa. Nema vanjskih paketa, pa se može testirati samostalno.
const crypto = require("crypto");

class ValidationError extends Error {}
class NotFoundError extends Error {}

function parseYT(u) {
  const s = String(u || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : "";
}
const isHttp = u => /^https?:\/\/\S+$/i.test(u);

/* Iz zalijepljenog iframe koda (<iframe src="...">) izvuče adresu; običan link vrati nepromijenjen */
function extractUrl(raw) {
  const s = String(raw || "").trim();
  if (/<iframe/i.test(s)) { const m = s.match(/\bsrc\s*=\s*["']([^"']+)["']/i); return m ? m[1].replace(/&amp;/g, "&").trim() : ""; }
  return s;
}
/* Prepoznaje izvor koji se može sinhronizirati: YouTube, Vimeo ili direktan video link (.mp4, .webm, .m3u8...).
   Vraća { type: "yt"|"vimeo"|"file", id, url } ili null. */
function parseMedia(raw) {
  const u = extractUrl(raw);
  if (!u) return null;
  const yt = parseYT(u);
  if (yt) return { type: "yt", id: yt, url: "https://www.youtube.com/watch?v=" + yt };
  const vm = u.match(/^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/|channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?(\d{5,12})(?:\/([0-9a-f]{8,16}))?(?:[?#]\S*)?$/i);
  if (vm) {
    const h = vm[2] || (u.match(/[?&]h=([0-9a-f]{8,16})/i) || [])[1] || "";
    return { type: "vimeo", id: vm[1] + (h ? ":" + h : ""), url: "https://vimeo.com/" + vm[1] + (h ? "/" + h : "") };
  }
  if (/^https?:\/\/(?:[\w-]+\.)*(?:dailymotion\.com|dai\.ly)\//i.test(u)) return null; // Dailymotion još nije podržan (traži vlastiti Player ID)
  if (isHttp(u) && u.length <= 2000) return { type: "file", id: "", url: u };
  return null;
}

function clean(input) {
  const i = input || {};
  const title = String(i.title || "").trim();
  if (!title) throw new ValidationError("Naslov je obavezan.");
  if (title.length > 100) throw new ValidationError("Naslov je predug (najviše 100 znakova).");

  const description = String(i.description || "").trim();
  if (description.length > 2000) throw new ValidationError("Opis je predug (najviše 2000 znakova).");

  let year = "";
  if (i.year !== undefined && i.year !== null && String(i.year).trim() !== "") {
    const y = parseInt(i.year, 10);
    if (!(y >= 1888 && y <= 2100)) throw new ValidationError("Godina nije ispravna.");
    year = y;
  }

  const rawGenres = Array.isArray(i.genres) ? i.genres : String(i.genres || "").split(",");
  const genres = [];
  for (const g of rawGenres.map(x => String(x).trim().slice(0, 30)).filter(Boolean)) {
    if (!genres.some(x => x.toLowerCase() === g.toLowerCase())) genres.push(g);
  }
  if (genres.length > 5) throw new ValidationError("Najviše 5 žanrova.");

  const poster = String(i.poster || "").trim();
  if (poster && (!isHttp(poster) || poster.length > 500)) throw new ValidationError("Link na sliku mora početi sa http:// ili https://.");

  const trailerRaw = String(i.trailer !== undefined ? i.trailer : (i.trailerId || "")).trim();
  const trailerId = trailerRaw ? parseYT(trailerRaw) : "";
  if (trailerRaw && !trailerId) throw new ValidationError("Trailer mora biti YouTube link.");

  let movieUrl = String(i.movieUrl || "").trim();
  if (movieUrl) {
    const media = parseMedia(movieUrl);
    if (!media || media.url.length > 1000) throw new ValidationError("Link na film nije prepoznat. Zalijepi YouTube, Vimeo ili direktan video link (.mp4, .webm, .m3u8), ili iframe kod tih servisa.");
    movieUrl = media.url;
  }

  if (!trailerId && !movieUrl) throw new ValidationError("Dodajte YouTube trailer ili link na film.");

  return { title, description, year, genres, poster, trailerId, movieUrl, featured: !!i.featured };
}

function create(list, input, now = Date.now()) {
  const film = { id: crypto.randomBytes(6).toString("hex"), ...clean(input), createdAt: now, updatedAt: now };
  return { list: [film, ...list], film };
}
function update(list, id, input, now = Date.now()) {
  const idx = list.findIndex(f => f.id === id);
  if (idx < 0) throw new NotFoundError("Film ne postoji.");
  const film = { ...list[idx], ...clean(input), updatedAt: now };
  const copy = list.slice(); copy[idx] = film;
  return { list: copy, film };
}
function remove(list, id) {
  const idx = list.findIndex(f => f.id === id);
  if (idx < 0) throw new NotFoundError("Film ne postoji.");
  return { list: list.filter(f => f.id !== id), film: list[idx] };
}

/* Šta se pušta svima kad neko klikne "Pogledaj u grupi": cijeli film ako je dodan, inače trailer */
function groupVideo(film) {
  const m = film.movieUrl && parseMedia(film.movieUrl);
  if (m) return { ...m, title: film.title };
  return { type: "yt", id: film.trailerId, url: "https://www.youtube.com/watch?v=" + film.trailerId, title: film.title + " (trailer)" };
}

/* Primjeri za prvo pokretanje (otvoreni filmovi Blender fondacije); admin ih može obrisati ili urediti */
function seed(now = Date.now()) {
  const items = [
    { title: "Big Buck Bunny", year: 2008, genres: "Animirani, Kratki film", trailer: "YE7VzlLtp-4", featured: true,
      description: "Kratki animirani film Blender fondacije o velikom, dobroćudnom zecu i trojici nestašnih glodara koji mu uzmu mir." },
    { title: "Sintel", year: 2010, genres: "Animirani, Fantazija", trailer: "eRsGyueVLvQ",
      description: "Mlada djevojka traži zmaja kojeg je jednom spasila. Otvoreni animirani film Blender fondacije." },
    { title: "Tears of Steel", year: 2012, genres: "Naučna fantastika, Kratki film", trailer: "R6MlUcmOul8",
      description: "Grupa boraca i naučnika pokušava spasiti svijet od robota. Otvoreni film Blender fondacije sa snimljenim i računarskim scenama." }
  ];
  return items.map((it, k) => ({ id: "primjer" + (k + 1), ...clean(it), createdAt: now - k, updatedAt: now - k }));
}

module.exports = { extractUrl, parseMedia, ValidationError, NotFoundError, parseYT, clean, create, update, remove, groupVideo, seed };
