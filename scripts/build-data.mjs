// Génère data/albums.json à partir de la base Notion « Musiques écoutées ».
//
// - Avec la variable NOTION_TOKEN : lit la base via l'API Notion (+ le texte de chaque fiche = ton avis).
// - Sans NOTION_TOKEN : utilise scripts/seed-rows.json (export initial).
// Dans les deux cas, les pochettes sont récupérées via l'API iTunes à partir des liens Apple Music.
//
// Usage : node scripts/build-data.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "albums.json");
const SEED = path.join(ROOT, "scripts", "seed-rows.json");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || "2a4a7bc0-f6df-80c3-bd83-000b2fd1b71e";
const NOTION_VERSION = "2025-09-03";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Notion ----------
async function notion(pathname, { method = "GET", body } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Notion ${method} ${pathname} → ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error(`Notion ${pathname} : trop de requêtes`);
}

const plain = (rich = []) => rich.map((t) => t.plain_text).join("").trim();

async function fetchReview(pageId) {
  const lines = [];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const data = await notion(`/blocks/${pageId}/children${q}`);
    for (const b of data.results) {
      const v = b[b.type];
      if (v && Array.isArray(v.rich_text)) {
        const txt = plain(v.rich_text);
        if (txt) lines.push(txt);
      }
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return lines.join("\n").slice(0, 1200);
}

async function fromNotion() {
  const rows = [];
  let cursor;
  do {
    const data = await notion(`/data_sources/${DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    for (const page of data.results) {
      const p = page.properties;
      const note = p["Note"]?.select?.name || "";
      rows.push({
        id: page.id.replace(/-/g, ""),
        album: plain(p["Album"]?.title),
        artist: p["Artiste"]?.select?.name || null,
        genres: (p["Genre"]?.multi_select || []).map((g) => g.name),
        lang: p["Langue principale"]?.select?.name || null,
        rating: note ? (note.match(/⭐/g) || []).length : null,
        listened: !!p["Ecouté"]?.checkbox,
        listenedOn: p["Date d'écoute"]?.date?.start || null,
        released: p["Date de sortie"]?.date?.start || null,
        link: p["URL"]?.url || null,
        cover: page.cover?.external?.url || page.cover?.file?.url || null,
      });
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  // Avis = texte de la fiche (uniquement pour les albums écoutés)
  for (const r of rows) {
    if (!r.listened || !r.album) continue;
    try { r.review = await fetchReview(r.id); } catch (e) { console.warn("Avis non lu :", r.album, e.message); }
    await sleep(340); // ~3 requêtes/s
  }
  return rows;
}

async function fromSeed() {
  const raw = JSON.parse(await readFile(SEED, "utf8"));
  return raw.map(([id, album, artist, genres, lang, rating, listened, listenedOn, released, link]) => ({
    id, album, artist, genres, lang, rating, listened, listenedOn, released, link,
  }));
}

// ---------- Nettoyage ----------
function cleanLink(link) {
  if (!link) return null;
  const m = link.match(/https?:\/\/.*?(?=https?:\/\/|$)/); // corrige les URL collées deux fois
  return m ? m[0] : link;
}

function appleId(link) {
  if (!link || !link.includes("music.apple.com")) return null;
  const m = new URL(link).pathname.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

function normalize(rows) {
  const out = rows
    .filter((r) => r.album && r.artist)
    .map((r) => ({ ...r, link: cleanLink(r.link), genres: r.genres || [] }));
  // Si un album figure à la fois « écouté » et « à écouter », on garde la version écoutée.
  const heard = new Set(out.filter((r) => r.listened).map((r) => `${r.artist}|${r.album}`.toLowerCase()));
  return out.filter((r) => r.listened || !heard.has(`${r.artist}|${r.album}`.toLowerCase()));
}

// ---------- Pochettes (iTunes) ----------
async function addCovers(rows, previous) {
  const prevById = new Map(previous.map((a) => [a.id, a]));
  for (const r of rows) {
    if (!r.cover && prevById.get(r.id)?.cover) r.cover = prevById.get(r.id).cover;
  }
  const missing = [...new Set(rows.filter((r) => !r.cover).map((r) => appleId(r.link)).filter(Boolean))];
  const found = new Map();
  for (let i = 0; i < missing.length; i += 150) {
    const ids = missing.slice(i, i + 150).join(",");
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${ids}&country=fr`);
      const data = await res.json();
      for (const it of data.results || []) {
        if (it.collectionId && it.artworkUrl100) {
          found.set(String(it.collectionId), it.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb."));
        }
      }
    } catch (e) {
      console.warn("Pochettes iTunes indisponibles :", e.message);
    }
  }
  for (const r of rows) {
    if (!r.cover) r.cover = found.get(appleId(r.link)) || null;
  }
  return rows;
}

// ---------- Main ----------
const previous = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")).albums || [] : [];
const source = NOTION_TOKEN ? "notion" : "seed";
let rows = normalize(NOTION_TOKEN ? await fromNotion() : await fromSeed());

// Sans Notion, on conserve les avis déjà récupérés lors d'une synchro précédente.
if (!NOTION_TOKEN) {
  const prevById = new Map(previous.map((a) => [a.id, a]));
  rows = rows.map((r) => ({ ...r, review: prevById.get(r.id)?.review || r.review }));
}

rows = await addCovers(rows, previous);
rows.sort((a, b) => (b.listenedOn || "").localeCompare(a.listenedOn || "") || a.album.localeCompare(b.album));

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({ updatedAt: new Date().toISOString(), source, albums: rows }, null, 1) + "\n",
);
console.log(`${rows.length} albums écrits dans data/albums.json (source : ${source}, pochettes : ${rows.filter((r) => r.cover).length})`);
