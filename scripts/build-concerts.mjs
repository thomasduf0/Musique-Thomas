// Génère data/concerts.json à partir des bases Notion « Événements » et « Passages » (page Concerts).
//
// - Avec la variable NOTION_TOKEN : lit les deux bases via l'API Notion.
// - Sinon : lit les données via la fonction Cloudflare (route /export/concerts).
// - Si aucune source ne répond : garde le fichier existant.
// Les salles sont placées sur la carte grâce à data/venues.json ; une salle absente est cherchée
// sur OpenStreetMap (Nominatim) puis ajoutée au fichier, qu'on peut corriger à la main.
//
// Usage : node scripts/build-concerts.mjs

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "concerts.json");
const VENUES = path.join(ROOT, "data", "venues.json");
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const EVENTS_ID = process.env.NOTION_CONCERTS_EVENTS_ID || "66d1893c-9687-400c-8db4-b326d77d49b7";
const ACTS_ID = process.env.NOTION_CONCERTS_ACTS_ID || "4f702733-8806-49d8-9092-34b497dc969d";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (rich = []) => rich.map((t) => t.plain_text).join("").trim();
const id = (x) => x.replace(/-/g, "");

// ---------- Sources ----------
async function queryAll(dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (res.status === 429) { await sleep(1500); continue; }
    if (!res.ok) throw new Error(`Notion ${res.status} ${await res.text()}`);
    const d = await res.json();
    pages.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return pages;
}

async function fromNotion() {
  const [evPages, actPages] = [await queryAll(EVENTS_ID), await queryAll(ACTS_ID)];
  const events = evPages.map((page) => {
    const p = page.properties;
    return {
      id: id(page.id), name: plain(p["Nom"]?.title),
      type: p["Type"]?.select?.name || "Concert", status: p["Statut"]?.select?.name || "Vu",
      start: p["Date"]?.date?.start || null, end: p["Date"]?.date?.end || null,
      venue: plain(p["Salle"]?.rich_text) || null, city: plain(p["Ville"]?.rich_text) || null,
      comment: plain(p["Commentaire"]?.rich_text) || null,
    };
  });
  const acts = actPages.map((page) => {
    const p = page.properties;
    const rel = p["Événement"]?.relation?.[0]?.id;
    return {
      id: id(page.id), artist: plain(p["Artiste"]?.title), event: rel ? id(rel) : null,
      date: p["Date"]?.date?.start || null, setlist: p["Setlist"]?.url || null,
      media: p["Média"]?.url || null, mediaType: p["Type de média"]?.select?.name || null,
      rating: p["Note"]?.number ?? null, comment: plain(p["Commentaire"]?.rich_text) || null,
    };
  });
  return { events, acts };
}

async function workerApi() {
  if (process.env.MUSIQUE_API) return process.env.MUSIQUE_API.replace(/\/$/, "");
  const cfg = await readFile(path.join(ROOT, "assets", "config.js"), "utf8").catch(() => "");
  return (cfg.match(/MUSIQUE_API\s*=\s*"([^"]+)"/) || [])[1]?.replace(/\/$/, "") || null;
}

async function fromWorker(api) {
  const res = await fetch(`${api}/export/concerts`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.events)) throw new Error(`Export concerts : ${data.error || res.status}`);
  return data;
}

// ---------- Carte : coordonnées des salles ----------
async function geocode(q) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=fr&q=${encodeURIComponent(q)}`, {
    headers: { "User-Agent": "musique-thomas/1.0 (github.com/thomasduf0/Musique-Thomas)", "Accept-Language": "fr" },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  return hit ? [+(+hit.lat).toFixed(4), +(+hit.lon).toFixed(4)] : null;
}

async function placeEvents(events) {
  const venues = existsSync(VENUES) ? JSON.parse(await readFile(VENUES, "utf8")) : {};
  let changed = false;
  for (const e of events) {
    if (!e.city) continue;
    const key = `${e.venue || ""}|${e.city}`, cityKey = `|${e.city}`;
    for (const [k, q] of [[cityKey, e.city], ...(e.venue ? [[key, `${e.venue}, ${e.city}`]] : [])]) {
      if (k in venues) continue;
      try {
        venues[k] = await geocode(q);
        changed = true;
        console.log(`Position trouvée pour « ${q} » :`, venues[k]);
      } catch (err) { console.warn(`Position introuvable pour « ${q} » :`, err.message); }
      await sleep(1100); // 1 requête par seconde maximum (règles d'OpenStreetMap)
    }
    const pos = venues[key] || venues[cityKey] || null;
    e.lat = pos?.[0] ?? null;
    e.lng = pos?.[1] ?? null;
  }
  if (changed) await writeFile(VENUES, JSON.stringify(venues, null, 1) + "\n");
}

// ---------- Main ----------
let data, source;
try {
  if (NOTION_TOKEN) { data = await fromNotion(); source = "notion"; }
  else {
    const api = await workerApi();
    if (!api) throw new Error("aucune source configurée");
    data = await fromWorker(api); source = "cloudflare";
  }
} catch (e) {
  console.warn("Concerts : source indisponible, fichier existant conservé :", e.message);
  process.exit(0);
}
data.events = data.events.filter((e) => e.name);
data.acts = data.acts.filter((a) => a.artist);
await placeEvents(data.events);
data.events.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.name.localeCompare(b.name));
data.acts.sort((a, b) => a.artist.localeCompare(b.artist, "fr") || (a.date || "").localeCompare(b.date || ""));
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source, ...data }, null, 1) + "\n");
console.log(`${data.events.length} événements et ${data.acts.length} passages écrits dans data/concerts.json (source : ${source})`);
