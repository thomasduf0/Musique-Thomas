// Fonction intermédiaire entre le site (GitHub Pages), Notion et Spotify.
// Elle garde les clés secrètes : le site n'y a jamais accès.
//
// Routes :
//   GET  /search?album=…&artist=…   recherche d'albums sur Spotify (mot de passe requis)
//   POST /albums                     crée une fiche dans la base Notion (mot de passe requis)
//   PATCH /albums/:pageId            modifie écouté / note / date / avis (mot de passe requis)
//   GET  /spotify/login?password=…   relie ton compte Spotify (une seule fois)
//   GET  /spotify/callback           retour de Spotify après autorisation
//   GET  /status                     état de la connexion Spotify et dernière vérification
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
  const allowed = origin === env.ALLOWED_ORIGIN || origin.startsWith("http://localhost");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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

async function searchAlbums(env, album, artist) {
  const token = await appToken(env);
  const q = [album && `album:${album}`, artist && `artist:${artist}`].filter(Boolean).join(" ");
  const data = await spotify(token, `/search?type=album&limit=10&market=FR&q=${encodeURIComponent(q)}`);
  const items = data.albums?.items || [];

  // Genres : récupérés sur les artistes principaux (peut être vide selon Spotify)
  const artistIds = [...new Set(items.map((a) => a.artists[0]?.id).filter(Boolean))].slice(0, 50);
  let genresByArtist = {};
  if (artistIds.length) {
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

  await env.STATE.put("spotify:played", JSON.stringify(played));
  await env.STATE.put("status:last_check", JSON.stringify({ at: new Date().toISOString(), newPlays: items.length, marked: done }));
  if (done.length) await triggerSiteUpdate(env);
  return { newPlays: items.length, marked: done };
}

// ---------------------------------------------------------------- routes
async function handle(req, env) {
  const url = new URL(req.url);
  const h = cors(env, req);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });

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
      if (!album && !artist) return json({ error: "Indique un album ou un artiste" }, 400, h);
      return json({ results: await searchAlbums(env, album, artist) }, 200, h);
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
      const published = await triggerSiteUpdate(env);
      return json({ ok: true, id: page.id, url: page.url, published }, 201, h);
    }

    const m = url.pathname.match(/^\/albums\/([0-9a-f-]{32,36})$/);
    if (m && req.method === "PATCH") {
      const a = await req.json();
      const props = notionProps({
        listened: a.listened,
        listenedOn: a.listened === false ? null : a.listened ? a.listenedOn || parisDate() : undefined,
        rating: a.rating,
      });
      await notion(env, `/pages/${m[1]}`, "PATCH", { properties: props });
      if (a.review) await notion(env, `/blocks/${m[1]}/children`, "PATCH", { children: reviewBlocks(a.review) });
      const published = await triggerSiteUpdate(env);
      return json({ ok: true, published }, 200, h);
    }

    if (url.pathname === "/check" && req.method === "POST") return json(await checkFullListens(env), 200, h);

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
