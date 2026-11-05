// Remplace les liens Apple Music / Qobuz de la base Notion par les liens Spotify.
//
//   MODE=preview  → cherche chaque album sur Spotify et écrit data/spotify-migration.json (rien n'est modifié)
//   MODE=apply    → applique dans Notion les correspondances de data/spotify-migration.json
//                   dont "apply" vaut true (on peut corriger le fichier entre les deux étapes)
//
// Variables : NOTION_TOKEN, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "data", "spotify-migration.json");
const DS = process.env.NOTION_DATA_SOURCE_ID || "2a4a7bc0-f6df-80c3-bd83-000b2fd1b71e";
const MODE = process.env.MODE || "preview";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notion(p, method = "GET", body) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`https://api.notion.com/v1${p}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
    const data = await res.json();
    if (!res.ok) throw new Error(`Notion ${p} : ${data.message}`);
    return data;
  }
  throw new Error("Notion : trop de requêtes");
}

let token;
async function spotify(p) {
  if (!token) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Spotify : ${d.error_description || d.error}`);
    token = d.access_token;
  }
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`https://api.spotify.com/v1${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) { await sleep((+res.headers.get("retry-after") || 2) * 1000); continue; }
    const d = await res.json();
    if (!res.ok) throw new Error(`Spotify : ${d.error?.message || res.status}`);
    return d;
  }
  throw new Error("Spotify : trop de requêtes");
}

// Comparaison tolérante : accents, ponctuation, mentions « deluxe », « remastered »…
const clean = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[’']/g, "").replace(/\((deluxe|remaster|expanded|edition|version|bonus)[^)]*\)|- (deluxe|remaster)[^-]*$/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

function score(album, artist, cand) {
  const a = clean(album), c = clean(cand.name);
  const artistOk = cand.artists.some((x) => clean(x.name) === clean(artist) || clean(x.name).includes(clean(artist)) || clean(artist).includes(clean(x.name)));
  let s = 0;
  if (artistOk) s += 2;
  if (a === c) s += 3; else if (a && c && (c.startsWith(a) || a.startsWith(c))) s += 2; else if (a && c && (c.includes(a) || a.includes(c))) s += 1;
  if (cand.album_type === "album") s += 0.5;
  return s;
}

async function preview() {
  const pages = [];
  let cursor;
  do {
    const d = await notion(`/data_sources/${DS}/query`, "POST", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);

  const out = [];
  for (const p of pages) {
    const album = (p.properties["Album"]?.title || []).map((t) => t.plain_text).join("").trim();
    const artist = p.properties["Artiste"]?.select?.name || "";
    const old = p.properties["URL"]?.url || null;
    if (!album || !artist) continue;
    if (old?.includes("open.spotify.com/album/")) continue;

    const queries = [`album:${album} artist:${artist}`, `${album} ${artist}`];
    let best = null;
    for (const q of queries) {
      const d = await spotify(`/search?type=album&limit=10&market=FR&q=${encodeURIComponent(q)}`);
      for (const c of d.albums?.items || []) {
        const s = score(album, artist, c);
        if (!best || s > best.s) best = { s, c };
      }
      if (best && best.s >= 5) break;
      await sleep(150);
    }

    const confidence = !best ? "aucun" : best.s >= 5 ? "sûr" : best.s >= 3.5 ? "probable" : "douteux";
    out.push({
      id: p.id,
      album, artist, old,
      spotify: best ? {
        name: best.c.name,
        artist: best.c.artists.map((a) => a.name).join(", "),
        released: best.c.release_date,
        tracks: best.c.total_tracks,
        url: `https://open.spotify.com/album/${best.c.id}`,
      } : null,
      confidence,
      apply: confidence === "sûr" || confidence === "probable",
    });
  }
  await writeFile(FILE, JSON.stringify(out, null, 1) + "\n");
  const count = (k) => out.filter((o) => o.confidence === k).length;
  console.log(`${out.length} albums : ${count("sûr")} sûrs, ${count("probable")} probables, ${count("douteux")} douteux, ${count("aucun")} sans résultat`);
}

async function apply() {
  const list = JSON.parse(await readFile(FILE, "utf8"));
  let n = 0;
  for (const o of list) {
    if (!o.apply || !o.spotify?.url) continue;
    await notion(`/pages/${o.id}`, "PATCH", { properties: { URL: { url: o.spotify.url } } });
    n++;
    await sleep(340);
  }
  console.log(`${n} liens remplacés dans Notion`);
}

await (MODE === "apply" ? apply() : preview());
