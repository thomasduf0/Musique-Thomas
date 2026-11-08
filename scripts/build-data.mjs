// Génère data/albums.json à partir de la base Notion « Musiques écoutées ».
//
// Version publique / privée :
// - data/albums.json (publié sur le site et gardé dans le dépôt) ne contient que les albums écoutés, sans les avis.
// - Les données complètes (albums à écouter, avis, conseils, cache Apple Music) sont envoyées à la fonction
//   Cloudflare (/private), lisibles uniquement avec le mot de passe. Il faut pour cela le secret GitHub
//   ADMIN_PASSWORD (même valeur que dans Cloudflare), passé au script dans la variable MUSIQUE_PASSWORD.
//
// - Avec la variable NOTION_TOKEN : lit la base via l'API Notion (+ le texte de chaque fiche = ton avis).
// - Sinon, si assets/config.js contient l'adresse de la fonction Cloudflare : lit les données via celle-ci.
// - Sinon : utilise scripts/seed-rows.json (export initial).
// Dans les deux cas, les pochettes sont récupérées via l'API iTunes à partir des liens Apple Music.
//
// Usage : node scripts/build-data.mjs

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { enrich } from "./enrich.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "albums.json");
const SEED = path.join(ROOT, "scripts", "seed-rows.json");
// Fichiers privés : jamais publiés ni enregistrés dans le dépôt (voir .gitignore)
const PRIV_DIR = path.join(ROOT, ".private");
const CACHE = path.join(PRIV_DIR, "enrich.json");
// Anciens emplacements dans le dépôt public, supprimés dès que les données privées sont dans Cloudflare
const LEGACY_CACHE = path.join(ROOT, "data", "enrich.json");
const LEGACY_RECO = path.join(ROOT, "data", "conseils.json");
const PASSWORD = process.env.MUSIQUE_PASSWORD || "";
const auth = PASSWORD ? { "X-Password": PASSWORD } : {};

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
        cover: page.cover?.external?.url || null,
        coverFile: page.cover?.file?.url || null, // image importée dans Notion : lien temporaire
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

// ---------- Pochettes importées dans Notion ----------
// Notion donne pour ces images un lien qui expire au bout d'une heure : on les copie dans covers/.
async function saveNotionFiles(rows) {
  const dir = path.join(ROOT, "covers");
  await mkdir(dir, { recursive: true });
  for (const r of rows) {
    if (!r.coverFile) continue;
    const u = new URL(r.coverFile);
    const ext = (path.extname(u.pathname).toLowerCase().match(/^\.(jpe?g|png|webp|gif|avif)$/) || [".jpg"])[0];
    const key = createHash("sha1").update(u.pathname).digest("hex").slice(0, 10);
    const name = `${r.id}-${key}${ext}`;
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      try {
        const res = await fetch(r.coverFile);
        if (!res.ok) throw new Error(res.status);
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        console.warn("Pochette Notion non téléchargée :", r.album, e.message);
        delete r.coverFile;
        continue;
      }
    }
    r.cover = `covers/${name}`;
    delete r.coverFile;
  }
  // Supprime les anciennes pochettes qui ne servent plus
  const used = new Set(rows.map((r) => r.cover).filter((c) => c?.startsWith("covers/")).map((c) => c.slice(7)));
  for (const f of await readdir(dir)) if (!used.has(f) && f !== ".gitkeep") await unlink(path.join(dir, f));
}

// ---------- Pochettes (iTunes, en secours) ----------
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

// ---------- Fonction Cloudflare (aucune clé nécessaire ici) ----------
async function workerApi() {
  if (process.env.MUSIQUE_API) return process.env.MUSIQUE_API.replace(/\/$/, "");
  try {
    const cfg = await readFile(path.join(ROOT, "assets", "config.js"), "utf8");
    return (cfg.match(/MUSIQUE_API\s*=\s*"([^"]+)"/) || [])[1]?.replace(/\/$/, "") || null;
  } catch { return null; }
}

async function fromWorker(api, previous) {
  const res = await fetch(`${api}/export`, { headers: auth });
  const data = await res.json();
  if (!res.ok) throw new Error(`Export : ${data.error || res.status}`);
  const rows = data.albums;
  // Avis : par lots, la fonction met en cache ceux qui n'ont pas changé
  const prev = new Map(previous.map((a) => [a.id, a]));
  const reviews = {};
  let pending = PASSWORD ? data.ids : []; // les avis ne sont lisibles qu'avec le mot de passe
  for (let round = 0; round < 10 && pending.length; round++) {
    for (let i = 0; i < pending.length; i += 50) {
      const r = await fetch(`${api}/export/reviews?ids=${encodeURIComponent(pending.slice(i, i + 50).join(","))}`, { headers: auth }).then((x) => x.json());
      Object.assign(reviews, r.reviews || {});
    }
    pending = pending.filter((s) => !(s.split(":")[0] in reviews));
  }
  for (const r of rows) r.review = reviews[r.id] ?? prev.get(r.id)?.review ?? undefined;
  return rows;
}

// ---------- Données privées (fonction Cloudflare) ----------
async function readPrivate(api) {
  if (!api || !PASSWORD) return null;
  try {
    const res = await fetch(`${api}/private`, { headers: auth });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
async function writePrivate(api, data) {
  if (!api || !PASSWORD) return false;
  try {
    const res = await fetch(`${api}/private`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    return true;
  } catch (e) { console.warn("Données privées non envoyées à Cloudflare :", e.message); return false; }
}

// ---------- Main ----------
if (!PASSWORD) console.warn("::warning::Secret ADMIN_PASSWORD absent : seule la version publique est mise à jour (pas d'avis, d'albums à écouter ni de conseils).");
const workerUrl = await workerApi();
const priv = await readPrivate(workerUrl);
await mkdir(PRIV_DIR, { recursive: true });
if (priv?.enrich) await writeFile(CACHE, JSON.stringify(priv.enrich) + "\n");
else if (existsSync(LEGACY_CACHE)) await writeFile(CACHE, await readFile(LEGACY_CACHE));
const previous = priv?.albums?.length ? priv.albums
  : existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")).albums || [] : [];
const API = NOTION_TOKEN ? null : workerUrl;
let source = NOTION_TOKEN ? "notion" : API ? "cloudflare" : "seed";
let rows;
try {
  rows = NOTION_TOKEN ? await fromNotion() : API ? await fromWorker(API, previous) : await fromSeed();
} catch (e) {
  console.warn("Source indisponible, données précédentes conservées :", e.message);
  source = "seed";
  rows = previous.length ? previous : await fromSeed();
}
rows = normalize(rows);

// Sans source en direct, on conserve les avis déjà récupérés lors d'une synchro précédente.
if (source === "seed") {
  const prevById = new Map(previous.map((a) => [a.id, a]));
  rows = rows.map((r) => ({ ...r, review: prevById.get(r.id)?.review || r.review }));
}

if (source !== "seed") await saveNotionFiles(rows);
for (const r of rows) { delete r.edited; delete r.coverFile; if (!r.review) delete r.review; }
rows = await addCovers(rows, previous);

// Conseils marqués « Pas intéressé » sur le site (stockés dans la fonction Cloudflare)
const flatK = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[\(\[][^\)\]]*[\)\]]/g, "").replace(/[^a-z0-9]+/g, "");
const recoKey = (artist, title) => `${flatK(artist)}|${flatK(title)}`;
let dismissed = new Set();
try {
  const api = await workerApi();
  if (api) {
    const d = await fetch(`${api}/dismissed`, { headers: auth }).then((r) => (r.ok ? r.json() : { dismissed: [] }));
    dismissed = new Set((d.dismissed || []).map((x) => x.key));
  }
} catch (e) { console.warn("Liste « Pas intéressé » indisponible :", e.message); }

// Genres et pochettes Apple Music, et albums conseillés
let reco = null;
try {
  reco = await enrich(rows, {
    cachePath: CACHE,
    selectionPath: path.join(ROOT, "data", "selection.json"),
    isDismissed: (artist, title) => dismissed.has(recoKey(artist, title)),
  });
  if (reco) {
    const keep = (r) => !dismissed.has(recoKey(r.artist, r.title));
    reco.fromArtists = reco.fromArtists.filter(keep);
    reco.picks = reco.picks.filter(keep);
  }
} catch (e) {
  console.warn("Enrichissement Apple Music indisponible :", e.message);
}
rows.sort((a, b) => (b.listenedOn || "").localeCompare(a.listenedOn || "") || a.album.localeCompare(b.album));

const updatedAt = new Date().toISOString();

// Version publique : albums écoutés uniquement, sans avis ni genres saisis à la main
const publicRows = rows.filter((r) => r.listened).map(({ review, myGenres, ...r }) => r);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt, source, albums: publicRows }, null, 1) + "\n");
console.log(`${publicRows.length} albums publics écrits dans data/albums.json (source : ${source}, pochettes : ${rows.filter((r) => r.cover).length})`);

// Version privée : tout, envoyée à la fonction Cloudflare
const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, "utf8")) : {};
const conseils = reco ? { updatedAt, ...reco } : priv?.conseils || null;
// (pas d'envoi si la source était indisponible : on ne remplace pas des données complètes par une copie partielle)
const sent = source !== "seed" && await writePrivate(workerUrl, { updatedAt, source, albums: rows, conseils, enrich: cache });
if (sent) {
  console.log(`Données privées envoyées à Cloudflare : ${rows.length} albums, ${rows.filter((r) => r.review).length} avis${conseils ? ", conseils" : ""}`);
  for (const f of [LEGACY_CACHE, LEGACY_RECO]) if (existsSync(f)) await unlink(f);
} else if (existsSync(LEGACY_CACHE)) {
  // Sans mot de passe, le cache reste à son ancien emplacement pour ne pas tout redemander à Apple Music
  await writeFile(LEGACY_CACHE, JSON.stringify(cache) + "\n");
}
