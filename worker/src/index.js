// Fonction intermédiaire entre le site (GitHub Pages), Notion et Spotify.
// Elle garde les clés secrètes : le site n'y a jamais accès.
//
// Routes :
//   GET  /search?album=…&artist=…   recherche d'albums sur Spotify (mot de passe requis)
//   GET  /genres?artist=<id Spotify>  genres d'un artiste (ajout depuis la barre de recherche)
//   POST /albums                     crée une fiche dans la base Notion (mot de passe requis)
//   PATCH /albums/:pageId            modifie écouté / note / date / avis (mot de passe requis)
//   GET  /spotify/login?password=…   relie ton compte Spotify (une seule fois)
//   GET  /spotify/callback           retour de Spotify après autorisation
//   GET  /status                     état de la connexion Spotify et dernière vérification
//   GET  /dismissed                  conseils marqués « Pas intéressé » (lecture publique)
//   POST /dismissed                  ajoute (ou retire avec undo) un conseil « Pas intéressé » (mot de passe requis)
//   GET  /export/concerts            concerts et festivals des bases Notion « Événements » et « Passages » (lecture publique)
//   POST /concerts/events            crée un concert ou un festival (mot de passe requis)
//   PATCH /concerts/events/:pageId   modifie nom, type, statut, dates, salle, ville (mot de passe requis)
//   POST /concerts/acts              ajoute un artiste vu (mot de passe requis)
//   PATCH /concerts/acts/:pageId     modifie artiste, concert rattaché, date, setlist, note (mot de passe requis)
//   DELETE /concerts/events/:pageId  met un concert et ses artistes à la corbeille Notion, ex. retrait de la wantlist (mot de passe requis)
// Tâche planifiée (toutes les heures) : coche « Écouté » quand toutes les pistes d'un album
// « à écouter » ont été jouées sur Spotify.

const NOTION_VERSION = "2025-09-03";
const GENRES = ["Pop", "Hip-hop/Rap", "Electro", "Rock", "Country", "Funk", "Alternative", "Gospel"];
const STARS = ["⭐️", "⭐️⭐️", "⭐️⭐️⭐️", "⭐️⭐️⭐️⭐️", "⭐️⭐️⭐️⭐️⭐️"];

// ---------------------------------------------------------------- utilitaires
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  // ALLOWED_ORIGIN peut lister plusieurs adresses séparées par des virgules (la 1re est l'adresse principale)
  const origins = (env.ALLOWED_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  const allowed = origins.includes(origin) || origin.startsWith("http://localhost");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : origins[0] || "",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Password",
    "Vary": "Origin",
  };
}

async function safeEqual(a = "", b = "") {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && !!b;
}

const parisDate = (d = new Date()) =>
  new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

// ---------------------------------------------------------------- Notion
async function notion(env, path, method = "GET", body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion : ${data.message || res.status}`);
  return data;
}

function notionProps(a) {
  const p = {};
  if (a.album !== undefined) p["Album"] = { title: [{ text: { content: a.album } }] };
  if (a.artist !== undefined) p["Artiste"] = { select: { name: a.artist.replace(/,/g, " ") } };
  if (a.genres !== undefined) p["Genre"] = { multi_select: a.genres.filter((g) => GENRES.includes(g)).map((name) => ({ name })) };
  if (a.lang !== undefined) p["Langue principale"] = { select: a.lang ? { name: a.lang } : null };
  if (a.released !== undefined) p["Date de sortie"] = { date: a.released ? { start: a.released } : null };
  if (a.link !== undefined) p["URL"] = { url: a.link || null };
  if (a.listened !== undefined) p["Ecouté"] = { checkbox: !!a.listened };
  if (a.listenedOn !== undefined) p["Date d'écoute"] = { date: a.listenedOn ? { start: a.listenedOn } : null };
  if (a.rating !== undefined) p["Note"] = { select: a.rating ? { name: STARS[a.rating - 1] } : null };
  return p;
}

function reviewBlocks(text) {
  return (text || "").split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({
    object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: t.slice(0, 1900) } }] },
  }));
}

// ---------------------------------------------------------------- Spotify
async function appToken(env) {
  const cached = await env.STATE.get("spotify:app_token");
  if (cached) return cached;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify : ${data.error_description || data.error || res.status}`);
  await env.STATE.put("spotify:app_token", data.access_token, { expirationTtl: Math.max(60, data.expires_in - 120) });
  return data.access_token;
}

async function userToken(env) {
  const refresh = await env.STATE.get("spotify:refresh_token");
  if (!refresh) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify (compte) : ${data.error_description || data.error || res.status}`);
  if (data.refresh_token) await env.STATE.put("spotify:refresh_token", data.refresh_token);
  return data.access_token;
}

async function spotify(token, path) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify : ${data.error?.message || res.status}`);
  return data;
}

// Traduit les genres Spotify (« french hip hop », « indie pop »…) vers les genres de la base
function mapGenres(spotifyGenres = []) {
  const g = spotifyGenres.join(" ").toLowerCase();
  const out = [];
  if (/hip hop|rap|trap|drill/.test(g)) out.push("Hip-hop/Rap");
  if (/pop/.test(g)) out.push("Pop");
  if (/electro|house|techno|edm|dance|electronic|synth/.test(g)) out.push("Electro");
  if (/rock|punk|metal|grunge/.test(g)) out.push("Rock");
  if (/country/.test(g)) out.push("Country");
  if (/funk|disco/.test(g)) out.push("Funk");
  if (/indie|alternative|alt /.test(g)) out.push("Alternative");
  if (/gospel/.test(g)) out.push("Gospel");
  return [...new Set(out)];
}

async function searchAlbums(env, album, artist, opts = {}) {
  const token = await appToken(env);
  const q = opts.q || [album && `album:${album}`, artist && `artist:${artist}`].filter(Boolean).join(" ");
  const data = await spotify(token, `/search?type=album&limit=10&market=FR&q=${encodeURIComponent(q)}`);
  const items = data.albums?.items || [];

  // Genres : récupérés sur les artistes principaux (peut être vide selon Spotify)
  const artistIds = [...new Set(items.map((a) => a.artists[0]?.id).filter(Boolean))].slice(0, 50);
  let genresByArtist = {};
  if (artistIds.length && opts.genres !== false) {
    try {
      const arts = await spotify(token, `/artists?ids=${artistIds.join(",")}`);
      genresByArtist = Object.fromEntries((arts.artists || []).filter(Boolean).map((a) => [a.id, a.genres || []]));
    } catch { /* genres facultatifs */ }
  }

  return items.map((a) => ({
    spotifyId: a.id,
    album: a.name,
    artist: a.artists.map((x) => x.name).join(", "),
    mainArtist: a.artists[0]?.name || "",
    artistId: a.artists[0]?.id || null,
    released: a.release_date_precision === "day" ? a.release_date : a.release_date_precision === "month" ? `${a.release_date}-01` : `${a.release_date}-01-01`,
    tracks: a.total_tracks,
    type: a.album_type,
    cover: a.images?.[0]?.url || null,
    thumb: a.images?.[a.images.length > 1 ? 1 : 0]?.url || null,
    link: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`,
    genres: mapGenres(genresByArtist[a.artists[0]?.id]),
  }));
}

// ---------------------------------------------------------------- republication du site
async function triggerSiteUpdate(env) {
  if (!env.GITHUB_TOKEN) return false;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "musique-thomas-worker" },
    body: JSON.stringify({ event_type: "notion-updated" }),
  });
  return res.ok;
}

// ---------------------------------------------------------------- détection d'écoute complète
// Mémorise, album par album, les pistes jouées (même réparties sur plusieurs jours),
// puis coche « Écouté » dans Notion quand toutes les pistes de l'album ont été jouées.
async function checkFullListens(env) {
  const token = await userToken(env);
  if (!token) return { skipped: "Spotify non relié" };

  const after = (await env.STATE.get("spotify:cursor")) || String(Date.now() - 24 * 3600 * 1000);
  const recent = await spotify(token, `/me/player/recently-played?limit=50&after=${after}`);
  const items = recent?.items || [];

  const played = JSON.parse((await env.STATE.get("spotify:played")) || "{}");
  for (const it of items) {
    const albumId = it.track?.album?.id;
    if (!albumId) continue;
    const key = `${it.track.disc_number}-${it.track.track_number}`;
    const entry = (played[albumId] ||= { keys: [], last: it.played_at });
    if (!entry.keys.includes(key)) entry.keys.push(key);
    if (it.played_at > entry.last) entry.last = it.played_at;
  }
  // On oublie les albums dont la dernière écoute date de plus de 30 jours
  const limit = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  for (const id of Object.keys(played)) if (played[id].last < limit) delete played[id];

  if (recent?.cursors?.after) await env.STATE.put("spotify:cursor", recent.cursors.after);
  await env.STATE.put("spotify:played", JSON.stringify(played));

  // Albums « à écouter » avec un lien Spotify
  const todo = await notion(env, `/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`, "POST", {
    page_size: 100,
    filter: { and: [
      { property: "Ecouté", checkbox: { equals: false } },
      { property: "URL", url: { contains: "open.spotify.com/album/" } },
    ] },
  });

  const done = [];
  for (const page of todo.results) {
    const albumId = page.properties["URL"]?.url?.match(/album\/([A-Za-z0-9]+)/)?.[1];
    const entry = albumId && played[albumId];
    if (!entry) continue;

    const tracks = [];
    let next = `/albums/${albumId}/tracks?limit=50&market=FR`;
    while (next) {
      const d = await spotify(token, next);
      tracks.push(...d.items);
      next = d.next ? d.next.replace("https://api.spotify.com/v1", "") : null;
    }
    const all = tracks.every((t) => entry.keys.includes(`${t.disc_number}-${t.track_number}`));
    if (!all) continue;

    await notion(env, `/pages/${page.id}`, "PATCH", { properties: notionProps({ listened: true, listenedOn: parisDate(entry.last) }) });
    delete played[albumId];
    done.push(page.properties["Album"]?.title?.[0]?.plain_text || albumId);
  }

  // Albums écoutés en entier mais absents de la base : proposés dans « À noter » sur la page d'ajout
  let found = [];
  try { found = await findHeardOutsideBase(env, token, played); }
  catch (e) { console.log("Albums hors base :", e.message); }

  await env.STATE.put("spotify:played", JSON.stringify(played));
  await env.STATE.put("status:last_check", JSON.stringify({ at: new Date().toISOString(), newPlays: items.length, marked: done, heard: found }));
  if (done.length) await triggerSiteUpdate(env);
  return { newPlays: items.length, marked: done };
}

const simple = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function findHeardOutsideBase(env, token, played) {
  const base = await exportAlbums(env);
  const ids = new Set(base.map((a) => a.link?.match(/album\/([A-Za-z0-9]+)/)?.[1]).filter(Boolean));
  const names = new Set(base.map((a) => `${simple(a.artist)}|${simple(a.album)}`));
  const heard = JSON.parse((await env.STATE.get("spotify:heard")) || "[]");
  const ignored = new Set(JSON.parse((await env.STATE.get("spotify:ignored")) || "[]"));
  const known = new Set(heard.map((h) => h.spotifyId));
  const found = [];
  let lookups = 0;
  for (const [albumId, entry] of Object.entries(played)) {
    if (ids.has(albumId) || ignored.has(albumId) || known.has(albumId) || entry.skip) continue;
    if (entry.keys.length < 5) continue; // trop peu de pistes pour un album
    if (!entry.meta) {
      if (lookups++ >= 15) continue; // le reste à la vérification suivante
      const a = await spotify(token, `/albums/${albumId}?market=FR`);
      if (a.album_type !== "album" || a.total_tracks < 5) { entry.skip = true; continue; }
      const tracks = [...(a.tracks?.items || [])];
      let next = a.tracks?.next ? a.tracks.next.replace("https://api.spotify.com/v1", "") : null;
      while (next) { const d = await spotify(token, next); tracks.push(...d.items); next = d.next ? d.next.replace("https://api.spotify.com/v1", "") : null; }
      entry.meta = {
        album: a.name,
        artist: a.artists?.[0]?.name || "",
        released: a.release_date_precision === "day" ? a.release_date : a.release_date_precision === "month" ? `${a.release_date}-01` : `${a.release_date}-01-01`,
        cover: a.images?.[0]?.url || null,
        thumb: a.images?.[a.images.length > 1 ? 1 : 0]?.url || null,
        link: a.external_urls?.spotify || `https://open.spotify.com/album/${albumId}`,
        tracks: tracks.map((t) => `${t.disc_number}-${t.track_number}`),
      };
    }
    const m = entry.meta;
    if (names.has(`${simple(m.artist)}|${simple(m.album)}`)) { entry.skip = true; continue; }
    if (!m.tracks.every((k) => entry.keys.includes(k))) continue;
    heard.push({ spotifyId: albumId, album: m.album, artist: m.artist, released: m.released, cover: m.cover, thumb: m.thumb, link: m.link, listenedOn: parisDate(entry.last), tracks: m.tracks.length });
    known.add(albumId);
    delete played[albumId];
    found.push(m.album);
  }
  if (found.length) await env.STATE.put("spotify:heard", JSON.stringify(heard.slice(-100)));
  return found;
}

// ---------------------------------------------------------------- export (lecture seule, public)
// Les données sont publiées sur le site de toute façon : la synchro GitHub les lit ici,
// sans avoir besoin d'aucune clé de son côté.
const plainText = (rich = []) => rich.map((t) => t.plain_text).join("").trim();

async function exportAlbums(env) {
  const cached = await env.STATE.get("cache:export");
  if (cached) return JSON.parse(cached);
  const albums = [];
  let cursor;
  do {
    const d = await notion(env, `/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`, "POST", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const page of d.results) {
      const p = page.properties;
      const note = p["Note"]?.select?.name || "";
      albums.push({
        id: page.id.replace(/-/g, ""),
        edited: page.last_edited_time,
        album: plainText(p["Album"]?.title),
        artist: p["Artiste"]?.select?.name || null,
        genres: (p["Genre"]?.multi_select || []).map((g) => g.name),
        lang: p["Langue principale"]?.select?.name || null,
        rating: note ? (note.match(/⭐/g) || []).length : null,
        listened: !!p["Ecouté"]?.checkbox,
        listenedOn: p["Date d'écoute"]?.date?.start || null,
        released: p["Date de sortie"]?.date?.start || null,
        link: p["URL"]?.url || null,
        cover: page.cover?.external?.url || null,
        coverFile: page.cover?.file?.url || null,
      });
    }
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  await env.STATE.put("cache:export", JSON.stringify(albums), { expirationTtl: 300 });
  return albums;
}

// Concerts : bases « Événements » (un concert ou un festival) et « Passages » (un artiste vu lors d'un événement)
async function queryAll(env, dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const d = await notion(env, `/data_sources/${dataSourceId}/query`, "POST", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return pages;
}

async function exportConcerts(env) {
  const cached = await env.STATE.get("cache:concerts");
  if (cached) return JSON.parse(cached);
  const id = (x) => x.replace(/-/g, "");
  const [evPages, actPages] = await Promise.all([
    queryAll(env, env.NOTION_CONCERTS_EVENTS_ID),
    queryAll(env, env.NOTION_CONCERTS_ACTS_ID),
  ]);
  const events = evPages.map((page) => {
    const p = page.properties;
    return {
      id: id(page.id),
      name: plainText(p["Nom"]?.title),
      type: p["Type"]?.select?.name || "Concert",
      status: p["Statut"]?.select?.name || "Vu",
      start: p["Date"]?.date?.start || null,
      end: p["Date"]?.date?.end || null,
      venue: plainText(p["Salle"]?.rich_text) || null,
      city: plainText(p["Ville"]?.rich_text) || null,
      comment: plainText(p["Commentaire"]?.rich_text) || null,
    };
  });
  const acts = actPages.map((page) => {
    const p = page.properties;
    return {
      id: id(page.id),
      artist: plainText(p["Artiste"]?.title),
      event: p["Événement"]?.relation?.[0]?.id ? id(p["Événement"].relation[0].id) : null,
      date: p["Date"]?.date?.start || null,
      setlist: p["Setlist"]?.url || null,
      media: p["Média"]?.url || null,
      mediaType: p["Type de média"]?.select?.name || null,
      rating: p["Note"]?.number ?? null,
      comment: plainText(p["Commentaire"]?.rich_text) || null,
    };
  }).filter((a) => a.artist);
  const out = { events, acts };
  await env.STATE.put("cache:concerts", JSON.stringify(out), { expirationTtl: 300 });
  return out;
}

// Propriétés Notion d'un concert / d'un passage (seuls les champs présents sont modifiés)
const rich = (v) => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] });
const dateProp = (start, end) => ({ date: start ? { start, end: end && end !== start ? end : null } : null });
const isDay = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
function eventProps(e) {
  const p = {};
  if ("name" in e) p["Nom"] = { title: [{ text: { content: String(e.name || "").slice(0, 200) } }] };
  if ("type" in e) p["Type"] = { select: { name: e.type === "Festival" ? "Festival" : "Concert" } };
  if ("status" in e) p["Statut"] = { select: { name: ["Vu", "À venir", "À vérifier", "Envie"].includes(e.status) ? e.status : "Vu" } };
  if ("start" in e) p["Date"] = dateProp(e.start, e.end);
  if ("venue" in e) p["Salle"] = rich(e.venue);
  if ("city" in e) p["Ville"] = rich(e.city);
  return p;
}
function actProps(a) {
  const p = {};
  if ("artist" in a) p["Artiste"] = { title: [{ text: { content: String(a.artist || "").slice(0, 200) } }] };
  if ("event" in a) p["Événement"] = { relation: a.event ? [{ id: a.event }] : [] };
  if ("date" in a) p["Date"] = dateProp(a.date);
  if ("setlist" in a) p["Setlist"] = { url: a.setlist || null };
  if ("rating" in a) p["Note"] = { number: a.rating ?? null };
  if ("event" in a) p["À compléter"] = { checkbox: !a.event };
  return p;
}
async function concertWrite(env, fn) {
  const out = await fn();
  await env.STATE.delete("cache:concerts");
  const published = await triggerSiteUpdate(env);
  return { ok: true, published, ...out };
}

// Avis (texte des fiches), par lots, mis en cache tant que la fiche n'est pas modifiée
async function exportReviews(env, items) {
  const out = {};
  let fetched = 0;
  for (const { id, edited } of items) {
    const key = `review:${id}`;
    const hit = JSON.parse((await env.STATE.get(key)) || "null");
    if (hit && hit.edited === edited) { out[id] = hit.text; continue; }
    if (fetched >= 40) continue; // limite de requêtes par appel : le reste au prochain appel
    const d = await notion(env, `/blocks/${id}/children?page_size=100`);
    fetched++;
    const text = d.results.map((b) => plainText(b[b.type]?.rich_text)).filter(Boolean).join("\n").slice(0, 1200);
    await env.STATE.put(key, JSON.stringify({ edited, text }));
    out[id] = text;
  }
  return out;
}

// ---------------------------------------------------------------- migration des liens vers Spotify
const fold = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[’']/g, "").replace(/\((deluxe|remaster|expanded|edition|version|bonus)[^)]*\)/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

function matchScore(album, artist, c) {
  const a = fold(album), n = fold(c.album), ar = fold(artist);
  const artistOk = c.artist.split(", ").some((x) => { const f = fold(x); return f === ar || f.includes(ar) || ar.includes(f); });
  let s = artistOk ? 2 : 0;
  if (a === n) s += 3; else if (a && n && (n.startsWith(a) || a.startsWith(n))) s += 2; else if (a && n && (n.includes(a) || a.includes(n))) s += 1;
  if (c.type === "album") s += 0.5;
  return s;
}

async function migratePreview(env, ids) {
  const albums = await exportAlbums(env);
  const out = [];
  for (const a of albums.filter((x) => ids.includes(x.id))) {
    if (!a.album || !a.artist) continue;
    let results = await searchAlbums(env, a.album, a.artist, { genres: false });
    if (!results.length) results = await searchAlbums(env, "", "", { genres: false, q: `${a.album} ${a.artist}` });
    const best = results.map((c) => ({ c, s: matchScore(a.album, a.artist, c) })).sort((x, y) => y.s - x.s)[0];
    const confidence = !best ? "aucun" : best.s >= 5 ? "sûr" : best.s >= 3.5 ? "probable" : "douteux";
    out.push({
      id: a.id, album: a.album, artist: a.artist, old: a.link, confidence,
      spotify: best ? { album: best.c.album, artist: best.c.artist, released: best.c.released, tracks: best.c.tracks, link: best.c.link, thumb: best.c.thumb } : null,
    });
  }
  return out;
}

async function dropHeard(env, id, ignore) {
  const heard = JSON.parse((await env.STATE.get("spotify:heard")) || "[]");
  await env.STATE.put("spotify:heard", JSON.stringify(heard.filter((x) => x.spotifyId !== id)));
  if (ignore) {
    const ignored = JSON.parse((await env.STATE.get("spotify:ignored")) || "[]");
    if (!ignored.includes(id)) ignored.push(id);
    await env.STATE.put("spotify:ignored", JSON.stringify(ignored.slice(-500)));
  }
}

// ---------------------------------------------------------------- routes
async function handle(req, env) {
  const url = new URL(req.url);
  const h = cors(env, req);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });

  // Lecture publique (aucune donnée qui ne soit déjà sur le site)
  if (req.method === "GET" && url.pathname === "/export") {
    try {
      const albums = await exportAlbums(env);
      return json({ albums, ids: albums.filter((a) => a.listened).map((a) => `${a.id}:${a.edited}`) }, 200, h);
    } catch (e) { return json({ error: e.message }, 502, h); }
  }
  // Déclenché chaque heure par la synchro GitHub (remplace un déclencheur cron Cloudflare).
  // Sans effet si une vérification a eu lieu il y a moins de 30 minutes.
  if (req.method === "POST" && url.pathname === "/tick") {
    const last = JSON.parse((await env.STATE.get("status:last_check")) || "null");
    if (last?.at && Date.now() - Date.parse(last.at) < 30 * 60 * 1000) return json({ skipped: "trop tôt" }, 200, h);
    try { return json(await checkFullListens(env), 200, h); }
    catch (e) {
      await env.STATE.put("status:last_check", JSON.stringify({ at: new Date().toISOString(), error: e.message }));
      return json({ error: e.message }, 502, h);
    }
  }
  if (req.method === "GET" && url.pathname === "/export/concerts") {
    try { return json(await exportConcerts(env), 200, h); }
    catch (e) { return json({ error: e.message }, 502, h); }
  }
  if (req.method === "GET" && url.pathname === "/dismissed") {
    return json({ dismissed: JSON.parse((await env.STATE.get("reco:dismissed")) || "[]") }, 200, h);
  }
  if (req.method === "GET" && url.pathname === "/export/reviews") {
    try {
      const items = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 100)
        .map((s) => { const [id, edited] = s.split(":"); return { id, edited: s.slice(id.length + 1) || edited }; })
        .filter((x) => /^[0-9a-f]{32}$/.test(x.id));
      return json({ reviews: await exportReviews(env, items) }, 200, h);
    } catch (e) { return json({ error: e.message }, 502, h); }
  }

  // Connexion du compte Spotify (une seule fois, depuis le navigateur)
  if (url.pathname === "/spotify/login") {
    if (!(await safeEqual(url.searchParams.get("password") || "", env.ADMIN_PASSWORD))) return new Response("Mot de passe incorrect", { status: 401 });
    const state = crypto.randomUUID();
    await env.STATE.put(`oauth:${state}`, "1", { expirationTtl: 600 });
    const auth = new URL("https://accounts.spotify.com/authorize");
    auth.search = new URLSearchParams({
      client_id: env.SPOTIFY_CLIENT_ID, response_type: "code", state,
      redirect_uri: `${url.origin}/spotify/callback`, scope: "user-read-recently-played",
    });
    return Response.redirect(auth.toString(), 302);
  }

  if (url.pathname === "/spotify/callback") {
    const state = url.searchParams.get("state");
    if (!state || !(await env.STATE.get(`oauth:${state}`))) return new Response("Lien expiré, recommence la connexion.", { status: 400 });
    await env.STATE.delete(`oauth:${state}`);
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: `${url.origin}/spotify/callback` }),
    });
    const data = await res.json();
    if (!res.ok || !data.refresh_token) return new Response(`Échec de la connexion Spotify : ${data.error_description || data.error}`, { status: 400 });
    await env.STATE.put("spotify:refresh_token", data.refresh_token);
    await env.STATE.put("spotify:cursor", String(Date.now()));
    return new Response(`<meta charset="utf-8"><body style="font-family:system-ui;padding:40px;background:#12100e;color:#f3ece3">
      <h1>✅ Spotify est relié</h1><p>Les albums « à écouter » seront cochés automatiquement une fois écoutés en entier. Tu peux fermer cette page.</p></body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Tout le reste exige le mot de passe
  if (!(await safeEqual(req.headers.get("X-Password") || "", env.ADMIN_PASSWORD))) return json({ error: "Mot de passe incorrect" }, 401, h);

  try {
    if (url.pathname === "/status" && req.method === "GET") {
      return json({
        spotifyLinked: !!(await env.STATE.get("spotify:refresh_token")),
        lastCheck: JSON.parse((await env.STATE.get("status:last_check")) || "null"),
        autoPublish: !!env.GITHUB_TOKEN,
      }, 200, h);
    }

    if (url.pathname === "/search" && req.method === "GET") {
      const album = url.searchParams.get("album")?.trim(), artist = url.searchParams.get("artist")?.trim();
      const q = url.searchParams.get("q")?.trim(); // recherche libre (barre de recherche du site)
      if (!album && !artist && !q) return json({ error: "Indique un album ou un artiste" }, 400, h);
      // Recherche libre : sans les genres (un appel Spotify de moins, réponse ~2× plus rapide) ;
      // ils sont demandés à /genres seulement quand un album est ajouté.
      return json({ results: await searchAlbums(env, album, artist, q ? { q, genres: false } : {}) }, 200, h);
    }

    if (url.pathname === "/genres" && req.method === "GET") {
      const id = url.searchParams.get("artist") || "";
      if (!/^[A-Za-z0-9]{10,30}$/.test(id)) return json({ error: "Artiste inconnu" }, 400, h);
      const art = await spotify(await appToken(env), `/artists/${id}`);
      return json({ genres: mapGenres(art?.genres) }, 200, h);
    }

    if (url.pathname === "/albums" && req.method === "POST") {
      const a = await req.json();
      if (!a.album || !a.artist) return json({ error: "Album et artiste obligatoires" }, 400, h);
      const page = await notion(env, "/pages", "POST", {
        parent: { type: "data_source_id", data_source_id: env.NOTION_DATA_SOURCE_ID },
        cover: a.cover ? { type: "external", external: { url: a.cover } } : undefined,
        properties: notionProps({
          album: a.album, artist: a.artist, genres: a.genres || [], lang: a.lang || null, released: a.released || null,
          link: a.link || null, listened: !!a.listened, listenedOn: a.listened ? a.listenedOn || parisDate() : null,
          rating: a.listened ? a.rating || null : null,
        }),
        children: reviewBlocks(a.review),
      });
      await env.STATE.delete("cache:export");
      if (a.fromHeard) await dropHeard(env, a.fromHeard, false);
      const published = await triggerSiteUpdate(env);
      return json({ ok: true, id: page.id, url: page.url, published }, 201, h);
    }

    // ---------- Concerts ----------
    if (url.pathname === "/concerts/events" && req.method === "POST") {
      const e = await req.json();
      if (!e.name?.trim()) return json({ error: "Nom du concert obligatoire" }, 400, h);
      if (!isDay(e.start) || !isDay(e.end)) return json({ error: "Date invalide" }, 400, h);
      return json(await concertWrite(env, async () => {
        const page = await notion(env, "/pages", "POST", {
          parent: { type: "data_source_id", data_source_id: env.NOTION_CONCERTS_EVENTS_ID },
          properties: eventProps({ type: "Concert", status: "Vu", ...e }),
        });
        return { id: page.id.replace(/-/g, "") };
      }), 201, h);
    }
    if (url.pathname === "/concerts/acts" && req.method === "POST") {
      const a = await req.json();
      if (!a.artist?.trim()) return json({ error: "Artiste obligatoire" }, 400, h);
      if (!isDay(a.date)) return json({ error: "Date invalide" }, 400, h);
      return json(await concertWrite(env, async () => {
        const page = await notion(env, "/pages", "POST", {
          parent: { type: "data_source_id", data_source_id: env.NOTION_CONCERTS_ACTS_ID },
          properties: actProps({ event: null, date: null, ...a }),
        });
        return { id: page.id.replace(/-/g, "") };
      }), 201, h);
    }
    const cm = url.pathname.match(/^\/concerts\/(events|acts)\/([0-9a-f-]{32,36})$/);
    if (cm && req.method === "PATCH") {
      const body = await req.json();
      if (!isDay(body.start) || !isDay(body.end) || !isDay(body.date)) return json({ error: "Date invalide" }, 400, h);
      const properties = cm[1] === "events" ? eventProps(body) : actProps(body);
      if (!Object.keys(properties).length) return json({ error: "Rien à modifier" }, 400, h);
      return json(await concertWrite(env, async () => {
        await notion(env, `/pages/${cm[2]}`, "PATCH", { properties });
        return {};
      }), 200, h);
    }

    if (cm && cm[1] === "events" && req.method === "DELETE") {
      // Corbeille Notion (restaurable) : le concert et les artistes qui y sont rattachés
      return json(await concertWrite(env, async () => {
        const acts = await notion(env, `/data_sources/${env.NOTION_CONCERTS_ACTS_ID}/query`, "POST", {
          filter: { property: "Événement", relation: { contains: cm[2] } }, page_size: 100,
        });
        for (const a of acts.results) await notion(env, `/pages/${a.id}`, "PATCH", { in_trash: true });
        await notion(env, `/pages/${cm[2]}`, "PATCH", { in_trash: true });
        return { removed: acts.results.length + 1 };
      }), 200, h);
    }

    const m = url.pathname.match(/^\/albums\/([0-9a-f-]{32,36})$/);
    if (m && req.method === "PATCH") {
      const a = await req.json();
      const props = notionProps({
        lang: a.lang,
        genres: a.genres,
        listened: a.listened,
        listenedOn: a.listened === false ? null : a.listened ? a.listenedOn || parisDate() : undefined,
        rating: a.rating,
      });
      await notion(env, `/pages/${m[1]}`, "PATCH", { properties: props });
      if (a.review) await notion(env, `/blocks/${m[1]}/children`, "PATCH", { children: reviewBlocks(a.review) });
      await env.STATE.delete("cache:export");
      const published = await triggerSiteUpdate(env);
      return json({ ok: true, published }, 200, h);
    }

    if (url.pathname === "/dismissed" && req.method === "POST") {
      const { key, artist = "", title = "", undo = false } = await req.json();
      if (!key || typeof key !== "string" || key.length > 300) return json({ error: "Conseil inconnu" }, 400, h);
      let list = JSON.parse((await env.STATE.get("reco:dismissed")) || "[]").filter((x) => x.key !== key);
      if (!undo) list.push({ key, artist: String(artist).slice(0, 200), title: String(title).slice(0, 200), at: parisDate() });
      await env.STATE.put("reco:dismissed", JSON.stringify(list.slice(-2000)));
      return json({ ok: true, count: list.length }, 200, h);
    }

    if (url.pathname === "/heard" && req.method === "GET") {
      return json({ heard: JSON.parse((await env.STATE.get("spotify:heard")) || "[]") }, 200, h);
    }
    const hm = url.pathname.match(/^\/heard\/([A-Za-z0-9]+)$/);
    if (hm && req.method === "DELETE") { await dropHeard(env, hm[1], true); return json({ ok: true }, 200, h); }

    if (url.pathname === "/check" && req.method === "POST") return json(await checkFullListens(env), 200, h);

    // Migration : liste des albums à traiter, puis aperçu par lots de 15, puis application
    if (url.pathname === "/migrate/todo" && req.method === "GET") {
      const albums = await exportAlbums(env);
      return json({ ids: albums.filter((a) => a.album && a.artist && !a.link?.includes("open.spotify.com/album/")).map((a) => a.id) }, 200, h);
    }
    if (url.pathname === "/migrate/preview" && req.method === "POST") {
      const { ids = [] } = await req.json();
      return json({ results: await migratePreview(env, ids.slice(0, 15)) }, 200, h);
    }
    if (url.pathname === "/migrate/apply" && req.method === "POST") {
      const { items = [] } = await req.json();
      let n = 0;
      for (const it of items.slice(0, 40)) {
        if (!/^[0-9a-f]{32}$/.test(it.id) || !/^https:\/\/open\.spotify\.com\/album\/[A-Za-z0-9]+$/.test(it.link)) continue;
        await notion(env, `/pages/${it.id}`, "PATCH", { properties: { URL: { url: it.link } } });
        n++;
      }
      await env.STATE.delete("cache:export");
      return json({ ok: true, updated: n }, 200, h);
    }

    return json({ error: "Route inconnue" }, 404, h);
  } catch (e) {
    return json({ error: e.message }, 502, h);
  }
}

export default {
  fetch: handle,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkFullListens(env).catch((e) => env.STATE.put("status:last_check", JSON.stringify({ at: new Date().toISOString(), error: e.message }))));
  },
};
