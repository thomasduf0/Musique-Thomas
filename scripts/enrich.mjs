// Enrichissement via l'API publique iTunes / Apple Music (sans clé) :
// - genre de chaque album tel qu'affiché sur Apple Music (en français),
// - pochette de secours en 600×600,
// - « Conseillés pour Thomas » : albums des artistes écoutés 2 fois ou plus, pas encore écoutés
//   (sans rééditions, éditions deluxe, live, compilations, remix, singles ni EP),
//   + une sélection faite à la main (data/selection.json).
//
// Les réponses sont gardées dans data/enrich.json : seuls les nouveaux albums sont interrogés,
// et les discographies sont rafraîchies une fois par semaine.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const COUNTRY = "country=fr&lang=fr_fr";
const WEEK = 14 * 24 * 3600 * 1000; // discographies rafraîchies toutes les 2 semaines
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Utilitaires ----------
export const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`]/g, "'");
// Titre « de base » : sans parenthèses/crochets, sans « - Single » / « - EP », sans ponctuation
export const baseTitle = (s) => norm(s)
  .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, " ")
  .replace(/\s+-\s+(single|ep)\s*$/, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

// Pochettes Apple « originales » (a5.mzstatic.com/us/r1000/0/…) : Apple ne les sert plus,
// on les convertit en vignette 600×600 du même visuel.
export function fixCover(url) {
  if (!url) return url;
  const m = url.match(/^https?:\/\/a\d+\.mzstatic\.com\/us\/r\d+\/\d+\/(.+)$/);
  return m ? `https://is1-ssl.mzstatic.com/image/thumb/${m[1]}/600x600bb.jpg` : url;
}
const art600 = (u) => u ? u.replace(/\/\d+x\d+bb\./, "/600x600bb.") : null;

function appleId(link) {
  if (!link || !link.includes("music.apple.com")) return null;
  try { return (new URL(link).pathname.match(/\/(\d+)\/?$/) || [])[1] || null; } catch { return null; }
}

// ---------- Appels iTunes (limite ≈ 20 requêtes/minute) ----------
let last = 0;
let calls = 0;
const MAX_CALLS = 60; // garde-fou par synchro ; le reste sera fait à la synchro suivante
let blocked = false;
async function itunes(query) {
  if (blocked) throw new Error("Apple Music limite les requêtes, suite à la prochaine synchro");
  if (calls >= MAX_CALLS) throw new Error("quota de la synchro atteint");
  const wait = last + 3100 - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  calls++;
  const res = await fetch(`https://itunes.apple.com/${query}${query.includes("?") ? "&" : "?"}${COUNTRY}`);
  if (res.status === 403 || res.status === 429) { blocked = true; throw new Error(`iTunes ${res.status}`); }
  if (!res.ok) throw new Error(`iTunes ${res.status}`);
  return (await res.json()).results || [];
}
const RETRY = 3 * 24 * 3600 * 1000; // un album introuvable est recherché à nouveau 3 jours plus tard
const stale = (e, key) => !e || e.key !== key || (e.notFound && Date.now() - (e.at || 0) > RETRY);

function bestMatch(results, artist, album) {
  const a = norm(artist).replace(/[^a-z0-9]+/g, " ").trim();
  const t = baseTitle(album);
  const scored = results
    .filter((x) => x.wrapperType === "collection")
    .map((x) => {
      const xa = norm(x.artistName).replace(/[^a-z0-9]+/g, " ").trim();
      const xt = baseTitle(x.collectionName);
      let s = 0;
      if (xa === a) s += 4; else if (xa.includes(a) || a.includes(xa)) s += 2;
      if (xt === t) s += 4; else if (xt.startsWith(t) || t.startsWith(xt)) s += 2;
      if (/ - (single|ep)$/i.test(x.collectionName)) s -= 2;
      return [s, x];
    })
    .filter(([s]) => s >= 5)
    .sort((p, q) => q[0] - p[0]);
  return scored[0]?.[1] || null;
}

const info = (x) => ({
  appleId: String(x.collectionId),
  artistId: x.artistId || null,
  genre: x.primaryGenreName || null,
  cover: art600(x.artworkUrl100),
  url: x.collectionViewUrl ? x.collectionViewUrl.split("?")[0] : null,
  released: x.releaseDate ? x.releaseDate.slice(0, 10) : null,
  title: x.collectionName,
  artistName: x.artistName,
  tracks: x.trackCount,
});

// La recherche d'albums d'Apple est peu fiable : on passe par l'artiste puis sa discographie.
const ART = "https://is1-ssl.mzstatic.com/image/thumb/";
const pack = (x) => [x.collectionId, x.collectionName, x.trackCount, (x.releaseDate || "").slice(0, 10), x.primaryGenreName || null,
  (x.artworkUrl100 || "").replace(ART, "").replace(/\/\d+x\d+bb\.\w+$/, ""), x.artistId, x.artistName];
const unpack = ([collectionId, collectionName, trackCount, releaseDate, primaryGenreName, art, artistId, artistName]) => ({
  wrapperType: "collection", collectionId, collectionName, trackCount, releaseDate, primaryGenreName, artistId, artistName,
  artworkUrl100: art ? `${ART}${art}/100x100bb.jpg` : null,
  collectionViewUrl: `https://music.apple.com/fr/album/${collectionId}`,
});

async function artistIdFor(name, cache) {
  const k = norm(name);
  if (k in cache.artistIds) return cache.artistIds[k];
  const known = Object.values(cache.albums).find((e) => e.artistId && norm(e.key.split("|")[0]) === k);
  if (known) return (cache.artistIds[k] = known.artistId);
  const res = await itunes(`search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=10`);
  const flat = (s) => norm(s).replace(/[^a-z0-9]+/g, "");
  const hit = res.find((x) => flat(x.artistName) === flat(name)) || res.find((x) => flat(x.artistName).includes(flat(name)));
  return (cache.artistIds[k] = hit ? hit.artistId : null);
}

async function discography(aid, cache) {
  const d = cache.disco[aid];
  if (d && Date.now() - d.at < WEEK) return d.list.map(unpack);
  try {
    const res = await itunes(`lookup?id=${aid}&entity=album&limit=200`);
    const own = res.filter((x) => x.wrapperType === "collection" && x.artistId === aid && !/ - (single|ep)$/i.test(x.collectionName));
    cache.disco[aid] = { at: Date.now(), list: own.map(pack) };
    return own;
  } catch (e) {
    if (d) return d.list.map(unpack);
    throw e;
  }
}

async function findAlbum(artist, album, cache) {
  const aid = await artistIdFor(artist, cache);
  if (aid) {
    const hit = bestMatch(await discography(aid, cache), artist, album) ||
      bestMatch((await discography(aid, cache)).map((x) => ({ ...x, artistName: artist })), artist, album);
    if (hit) return info(hit);
  }
  const res = await itunes(`search?term=${encodeURIComponent(`${artist} ${album}`.slice(0, 120))}&entity=album&limit=15`);
  const hit = bestMatch(res, artist, album);
  return hit ? info(hit) : null;
}

// ---------- Filtre des rééditions ----------
const REISSUE_IN_PARENS = /deluxe|remaster|r[eé]-?[eé]dition|edition|anniversa|expanded|reissue|version|remix|instrumental|acousti|karaok|bonus|director|complete|sessions|reload|unplugged|orchestr|symphon|live|tour|extended|special|collector|super|redux|revisit|reimagin|demo|b-sides|commentary|clean|from the vault|taylor/i;
const NOT_A_STUDIO_ALBUM = /best of|greatest|\bhits\b|collection|essentials|anthology|det b[aä]sta|the very best|\bsingles\b|compilation|\blive\b|alive \d|en concert|unplugged|soundtrack|bande originale|edition|édition|deluxe|world tour|dj mix|boiler room|apple music (presents|home session)|spotify (singles|sessions)|reconfigured|remix(es)?\b|instrumentals?\b|from the vault|[eé]pilogue|estate sale|daft club|vol\.? ?\d|acts? \d+ ?& ?\d+|completely different|three more songs|reloaded|redux|réédition|reedition/i;

function studioAlbums(results, artistId) {
  const own = results.filter((x) =>
    x.wrapperType === "collection" && x.artistId === artistId && !/ - (single|ep)$/i.test(x.collectionName));
  const keep = own.filter((x) => {
    const n = x.collectionName;
    const parens = (n.match(/[\(\[][^\)\]]*[\)\]]/g) || []).join(" ");
    if (x.trackCount < 9) return false;
    if (REISSUE_IN_PARENS.test(parens) || NOT_A_STUDIO_ALBUM.test(n)) return false;
    if (x.primaryGenreName === "Bande originale") return false;
    return true;
  });
  // Doublons (même titre de base) : on garde la première sortie
  const byBase = new Map();
  for (const x of keep) {
    const b = baseTitle(x.collectionName);
    const prev = byBase.get(b);
    if (!prev || (x.releaseDate || "") < (prev.releaseDate || "")) byBase.set(b, x);
  }
  // Titres qui reprennent un autre album de l'artiste en plus long et sortis après (« Extra-lucide »…)
  const bases = own.map((x) => [baseTitle(x.collectionName), x.releaseDate || ""]);
  // Réédition sous un autre nom (« Culte » = « Cure » augmenté) : sortie moins de 9 mois après
  // un autre album de l'artiste, avec nettement plus de titres
  const full = own.filter((y) => y.trackCount >= 9);
  const day = 24 * 3600 * 1000;
  const expanded = (x) => full.some((y) => {
    const gap = (Date.parse(x.releaseDate) - Date.parse(y.releaseDate)) / day;
    return y !== x && gap > 0 && gap < 270 && x.trackCount >= y.trackCount + 3;
  });
  return [...byBase.entries()]
    .filter(([b, x]) => !bases.some(([o, d]) => o !== b && o.length >= 4 && b.includes(o) && d < (x.releaseDate || "")))
    .filter(([, x]) => !expanded(x))
    .map(([, x]) => x);
}

// ---------- Programme principal ----------
export async function enrich(rows, { cachePath, selectionPath }) {
  const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, "utf8")) : {};
  cache.albums ||= {};
  delete cache.artists; // ancien format
  cache.artistIds ||= {};
  cache.disco ||= {};
  cache.picks ||= {};
  const keyOf = (r) => `${r.artist}|${r.album}|${r.link || ""}`;

  // 1. Albums de la base : correspondance Apple Music
  const todo = rows.filter((r) => stale(cache.albums[r.id], keyOf(r)));
  const byApple = new Map();
  todo.forEach((r) => { const id = appleId(r.link); if (id) (byApple.get(id) || byApple.set(id, []).get(id)).push(r); });
  const ids = [...byApple.keys()];
  for (let i = 0; i < ids.length; i += 150) {
    try {
      const res = await itunes(`lookup?id=${ids.slice(i, i + 150).join(",")}`);
      for (const x of res) {
        if (x.wrapperType !== "collection") continue;
        for (const r of byApple.get(String(x.collectionId)) || []) cache.albums[r.id] = { key: keyOf(r), ...info(x) };
      }
    } catch (e) { console.warn("Recherche Apple Music (lot) :", e.message); }
  }
  for (const r of todo) {
    if (!stale(cache.albums[r.id], keyOf(r))) continue;
    try {
      const hit = await findAlbum(r.artist, r.album, cache);
      cache.albums[r.id] = { key: keyOf(r), ...(hit || { notFound: true, at: Date.now() }) };
    } catch (e) { console.warn("Recherche Apple Music :", r.album, e.message); break; }
  }
  // Nettoyage des albums supprimés de la base
  const live = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(cache.albums)) if (!live.has(id)) delete cache.albums[id];

  // 2. Application : genre en ligne + pochette de secours
  for (const r of rows) {
    r.cover = fixCover(r.cover);
    const e = cache.albums[r.id];
    if (!e || e.notFound) continue;
    if (e.genre) { r.myGenres = r.genres; r.genres = [e.genre]; }
    if (!r.cover) r.cover = e.cover;
    else if (e.cover && e.cover !== r.cover) r.coverAlt = e.cover;
  }

  // 3. Conseils : artistes écoutés au moins 2 fois
  const heard = rows.filter((r) => r.listened);
  const known = new Set(rows.map((r) => `${norm(r.artist)}|${baseTitle(r.album)}`));
  const knownTitles = new Set(rows.map((r) => baseTitle(r.album)));
  const knownApple = new Set(rows.map((r) => cache.albums[r.id]?.appleId).filter(Boolean));
  const artists = new Map();
  for (const r of heard) {
    const k = norm(r.artist);
    const a = artists.get(k) || { name: r.artist, count: 0, ids: new Map() };
    a.count++;
    const aid = cache.albums[r.id]?.artistId;
    if (aid) a.ids.set(aid, (a.ids.get(aid) || 0) + 1);
    artists.set(k, a);
  }
  const fromArtists = [];
  for (const a of artists.values()) {
    if (a.count < 2 || !a.ids.size) continue;
    const aid = [...a.ids.entries()].sort((p, q) => q[1] - p[1])[0][0];
    let list;
    try { list = studioAlbums(await discography(aid, cache), aid).map(info); }
    catch (e) { console.warn("Discographie :", a.name, e.message); continue; }
    for (const x of list) {
      if (knownApple.has(x.appleId) || known.has(`${norm(a.name)}|${baseTitle(x.title)}`)) continue;
      fromArtists.push({ ...x, artist: a.name, heardCount: a.count });
    }
  }

  // 4. Sélection faite à la main
  const selection = existsSync(selectionPath) ? JSON.parse(await readFile(selectionPath, "utf8")) : [];
  const picks = [];
  const autoIds = new Set(fromArtists.map((x) => x.appleId));
  for (const p of selection) {
    const k = `${p.artist}|${p.album}`;
    if (knownTitles.has(baseTitle(p.album)) && known.has(`${norm(p.artist)}|${baseTitle(p.album)}`)) continue; // déjà dans la base
    if (!cache.picks[k] || (cache.picks[k].notFound && Date.now() - (cache.picks[k].at || 0) > RETRY)) {
      try { cache.picks[k] = (await findAlbum(p.artist, p.album, cache)) || { notFound: true, at: Date.now() }; }
      catch (e) { console.warn("Sélection :", p.album, e.message); }
    }
    const x = cache.picks[k] || {};
    if (x.appleId && (autoIds.has(x.appleId) || knownApple.has(x.appleId))) continue;
    picks.push({
      ...(x.notFound ? {} : x),
      title: p.album, artist: p.artist, why: p.why,
      released: x.released || p.year || null,
    });
  }

  await writeFile(cachePath, JSON.stringify(cache) + "\n");
  console.log(`Apple Music : ${calls} requêtes, ${rows.filter((r) => cache.albums[r.id]?.genre).length}/${rows.length} albums reconnus, ${fromArtists.length} conseils d'artistes, ${picks.length} sélections`);
  return { fromArtists, picks };
}
