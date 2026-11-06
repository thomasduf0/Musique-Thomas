(() => {
  const $ = (s) => document.querySelector(s);
  const API = (window.MUSIQUE_API || "").replace(/\/$/, "");
  const state = { view: "all", albums: [], reco: null, artist: null, current: null };
  const els = {
    grid: $("#grid"), stats: $("#stats"), reco: $("#reco"), artist: $("#artist"), filters: $("#filters"), count: $("#count"),
    q: $("#q"), genre: $("#genre"), lang: $("#lang"), rating: $("#rating"), sort: $("#sort"),
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d, opts = { day: "numeric", month: "short", year: "numeric" }) =>
    d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", opts) : "—";
  // Une date au 1er janvier vient en général d'une année seule : on n'affiche que l'année
  const fmtRelease = (d) => (d && /-01-01$/.test(d) ? d.slice(0, 4) : fmtDate(d));
  const stars = (n) => n ? `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>` : `<span class="chip">Non noté</span>`;
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());

  function toast(msg, err = false) {
    const t = $("#toast"), d = $("#detail");
    (d.open ? d : document.body).appendChild(t); // au-dessus de la fiche ouverte
    t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = "toast"), 4000);
  }

  // ---------- Mot de passe (le même que la page d'ajout) ----------
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  let password = store.get("musique:pw");

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", "X-Password": password, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { const e = new Error("Mot de passe incorrect"); e.auth = true; throw e; }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  function showGate(msg = "") {
    $("#gate").hidden = false;
    $("#gate-err").textContent = msg;
    setTimeout(() => $("#gate-pw").focus(), 50);
  }
  function unlock() {
    $("#gate").hidden = true;
    document.body.classList.remove("locked");
    load();
  }
  async function checkAccess() {
    if (!API || !password) return showGate();
    try {
      await api("/status");
      store.set("musique:ok", "1");
      unlock();
    } catch (e) {
      if (e.auth) { password = ""; store.set("musique:pw", ""); store.set("musique:ok", ""); return showGate("Mot de passe incorrect."); }
      // Fonction Cloudflare injoignable : on laisse entrer si ce mot de passe a déjà été validé
      if (store.get("musique:ok")) unlock(); else showGate("Vérification impossible pour le moment, réessaie dans un instant.");
    }
  }
  $("#gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    password = $("#gate-pw").value;
    store.set("musique:pw", password);
    $("#gate-err").textContent = "Vérification…";
    checkAccess();
  });

  // ---------- Pochettes ----------
  function hue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  // Les pochettes Apple « originales » (a5.mzstatic.com/us/r1000/…) ne sont plus servies : vignette 600×600
  const fixCover = (u) => {
    const m = (u || "").match(/^https?:\/\/a\d+\.mzstatic\.com\/us\/r\d+\/\d+\/(.+)$/);
    return m ? `https://is1-ssl.mzstatic.com/image/thumb/${m[1]}/600x600bb.jpg` : u;
  };
  window.__coverFail = (img) => {
    const alt = img.dataset.alt;
    if (alt && img.src !== alt) { img.dataset.alt = ""; img.src = alt; } else img.remove();
  };
  function coverHTML(a, big = false) {
    const h = hue(a.artist + a.album);
    const ph = `<div class="ph" style="background:linear-gradient(140deg,hsl(${h} 55% 38%),hsl(${(h + 50) % 360} 60% 18%))">${esc(a.album)}<small>${esc(a.artist)}</small></div>`;
    const src = fixCover(a.cover) || a.coverAlt;
    const img = src ? `<img src="${esc(src)}" data-alt="${esc(a.coverAlt && a.coverAlt !== src ? a.coverAlt : "")}" alt="Pochette de ${esc(a.album)}" loading="lazy" onerror="__coverFail(this)">` : "";
    const badge = !big && a.rating ? `<span class="badge">${"★".repeat(a.rating)}</span>` : "";
    return `<div class="cover">${ph}${img}${badge}${big ? `<span class="shine"></span>` : ""}</div>`;
  }
  const artistLink = (name, cls = "a-link") => `<span class="${cls}" role="link" tabindex="0" data-artist="${esc(name)}">${esc(name)}</span>`;

  // ---------- Avis : 1re écoute, puis « 2e écoute (date) », « 3e écoute »… ----------
  const LISTEN_RE = /^(\d+)e écoute(?:\s*\(([^)]*)\))?\s*:?\s*$/i;
  function reviewParts(text) {
    const parts = [{ title: null, lines: [] }];
    (text || "").split("\n").forEach((l) => {
      const m = l.trim().match(LISTEN_RE);
      if (m) parts.push({ title: `${m[1]}e écoute${m[2] ? " · " + m[2] : ""}`, lines: [] });
      else parts[parts.length - 1].lines.push(l);
    });
    return parts.filter((p) => p.title || p.lines.join("").trim());
  }
  const reviewHTML = (text) => reviewParts(text).map((p) =>
    `<div class="review${p.title ? " again" : ""}">${p.title ? `<b class="r-h">${esc(p.title)}</b>` : ""}${esc(p.lines.join("\n").trim())}</div>`).join("");
  const nextListen = (text) => 2 + reviewParts(text).filter((p) => p.title).length;

  // ---------- Rendu ----------
  function currentList() {
    const q = norm(els.q.value), g = els.genre.value, l = els.lang.value, r = +els.rating.value;
    let list = state.albums.filter((a) =>
      state.view === "todo" ? !a.listened :
      state.view === "fav" ? a.listened && a.rating === 5 : a.listened);
    if (q) list = list.filter((a) => norm(a.album + " " + a.artist).includes(q));
    if (g) list = list.filter((a) => a.genres.includes(g));
    if (l) list = list.filter((a) => a.lang === l);
    if (r) list = list.filter((a) => a.rating === r);

    const by = els.sort.value;
    const cmp = {
      listened: (a, b) => (b.listenedOn || "").localeCompare(a.listenedOn || ""),
      "listened-asc": (a, b) => (a.listenedOn || "9999").localeCompare(b.listenedOn || "9999"),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.listenedOn || "").localeCompare(a.listenedOn || ""),
      released: (a, b) => (b.released || "").localeCompare(a.released || ""),
      artist: (a, b) => a.artist.localeCompare(b.artist, "fr") || a.album.localeCompare(b.album, "fr"),
    }[state.view === "todo" && by.startsWith("listened") ? "released" : by];
    return list.sort(cmp);
  }

  const albumCard = (a) => `
      <button class="card" data-id="${a.id}">
        ${coverHTML(a)}
        <h3>${esc(a.album)}</h3>
        <p>${artistLink(a.artist)}</p>
        <p>${a.listened ? "Écouté le " + fmtDate(a.listenedOn) : "À écouter · sortie " + fmtRelease(a.released)}</p>
      </button>`;

  function renderGrid() {
    const list = currentList();
    const s = list.length > 1 ? "s" : "";
    els.count.textContent = `${list.length} album${s}${state.view === "todo" ? " à écouter" : ""}`;
    els.grid.innerHTML = list.length ? list.map(albumCard).join("") : `<p class="empty">Aucun album ne correspond à ces filtres.</p>`;
  }

  // ---------- Page artiste ----------
  function showArtist(name) {
    state.artist = name;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", "false"));
    render();
    window.scrollTo({ top: document.querySelector(".tabs").offsetTop, behavior: "smooth" });
  }
  function renderArtist() {
    const name = state.artist, key = norm(name);
    const list = state.albums.filter((a) => norm(a.artist) === key)
      .sort((a, b) => (b.released || "").localeCompare(a.released || ""));
    const heard = list.filter((a) => a.listened), rated = heard.filter((a) => a.rating);
    const avg = rated.length ? (rated.reduce((s, a) => s + a.rating, 0) / rated.length).toFixed(1).replace(".", ",") : null;
    const recos = recoList().map((r, i) => [r, i]).filter(([r]) => norm(r.artist) === key);
    const bits = [`${heard.length} écouté${heard.length > 1 ? "s" : ""}`];
    if (list.length - heard.length) bits.push(`${list.length - heard.length} à écouter`);
    if (avg) bits.push(`note moyenne ${avg} ★`);
    els.artist.innerHTML = `
      <button class="back-btn" type="button" data-back>← Retour</button>
      <h2>${esc(name)}</h2>
      <p class="sub">${bits.join(" · ")}</p>
      <div class="grid">${list.map(albumCard).join("")}</div>
      ${recos.length ? `<h3 class="artist-sub">Pas encore dans ta base</h3>
        <div class="grid">${recos.map(([r, i]) => recoCard(r, i)).join("")}</div>` : ""}`;
  }

  // ---------- Fiche album ----------
  const SPOTIFY_ARROW = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function goLink(href, label) {
    return href ? `<a class="go" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">${SPOTIFY_ARROW}</a>` : "";
  }
  const linkLabel = (l) => l?.includes("spotify") ? "Écouter sur Spotify" : l?.includes("qobuz") ? "Écouter sur Qobuz" : "Écouter sur Apple Music";

  function openDetail(id) {
    const a = state.albums.find((x) => x.id === id);
    if (!a) return;
    state.current = a;
    $("#detail-body").innerHTML = `
      <div class="d-wrap">
        <div class="d-left">${coverHTML(a, true)}</div>
        <div class="d-info">
          <h2>${esc(a.album)}</h2>
          <p class="d-artist">${artistLink(a.artist, "a-link big")}</p>
          ${a.listened ? stars(a.rating) : `<span class="chip">À écouter</span>`}
          <dl class="meta">
            <dt>Sortie</dt><dd>${fmtRelease(a.released)}</dd>
            ${a.listened ? `<dt>Écouté le</dt><dd>${fmtDate(a.listenedOn)}</dd>` : ""}
            ${a.lang ? `<dt>Langue</dt><dd>${esc(a.lang)}</dd>` : ""}
          </dl>
          <div class="chips" title="Genre Apple Music">${a.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>
          ${reviewHTML(a.review)}
          <button class="btn ghost edit-btn" type="button" data-edit>Modifier</button>
          ${editForm(a)}
        </div>
      </div>
      ${goLink(a.link, linkLabel(a.link))}`;
    const d = $("#detail");
    if (!d.open) d.showModal();
    tilt(d.querySelector(".d-left .cover"));
  }

  const rateHTML = (n) => `<div class="rate" data-rating="${n || 0}" aria-label="Note">${[1, 2, 3, 4, 5].map((v) =>
    `<button type="button" data-v="${v}" class="${v <= n ? "on" : ""}" aria-label="${v} étoile${v > 1 ? "s" : ""}">★</button>`).join("")}</div>`;
  function editForm(a) {
    if (a.listened) {
      const n = nextListen(a.review);
      return `<form class="edit" hidden>
        <div class="field"><span>Ma note</span>${rateHTML(a.rating)}</div>
        <label>Commentaire de ${n}e écoute<textarea name="review" rows="4" placeholder="Facultatif : ce que tu en penses à la réécoute"></textarea></label>
        <label>Date de cette écoute<input name="date" type="date" value="${today()}"></label>
        <div class="btns"><button class="btn">Enregistrer</button><button class="btn ghost" type="button" data-cancel>Annuler</button></div>
      </form>`;
    }
    return `<form class="edit" hidden>
      <p class="edit-title">Marquer comme écouté</p>
      <div class="field"><span>Ma note</span>${rateHTML(0)}</div>
      <label>Date d'écoute<input name="date" type="date" value="${today()}"></label>
      <label>Mon avis<textarea name="review" rows="4" placeholder="Facultatif"></textarea></label>
      <div class="btns"><button class="btn">Enregistrer</button><button class="btn ghost" type="button" data-cancel>Annuler</button></div>
    </form>`;
  }

  $("#detail-body").addEventListener("click", (e) => {
    const art = e.target.closest("[data-artist]");
    if (art) { $("#detail").close(); return showArtist(art.dataset.artist); }
    const form = $("#detail-body .edit");
    if (e.target.closest("[data-edit]")) { form.hidden = false; e.target.closest("[data-edit]").hidden = true; form.querySelector("textarea")?.focus(); return; }
    if (e.target.closest("[data-cancel]")) { form.hidden = true; $("#detail-body [data-edit]").hidden = false; return; }
    const star = e.target.closest(".rate button");
    if (star) {
      const box = star.parentElement;
      const v = +star.dataset.v === +box.dataset.rating ? 0 : +star.dataset.v;
      box.dataset.rating = v;
      box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v <= v));
    }
  });

  $("#detail-body").addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = state.current, form = e.target;
    const rating = +form.querySelector(".rate").dataset.rating || null;
    const text = form.review.value.trim(), date = form.date.value || today();
    const body = {};
    let review = "";
    if (a.listened) {
      if (rating !== (a.rating || null)) body.rating = rating;
      if (text) review = `${nextListen(a.review)}e écoute (${fmtDate(date)})\n${text}`;
    } else {
      Object.assign(body, { listened: true, listenedOn: date, rating });
      review = text;
    }
    if (review) body.review = review;
    if (!Object.keys(body).length) return toast("Rien à enregistrer", true);
    const btn = form.querySelector("button:not([type])"); btn.disabled = true;
    try {
      await api(`/albums/${a.id}`, { method: "PATCH", body: JSON.stringify(body) });
      if ("rating" in body) a.rating = body.rating;
      if (body.listened) { a.listened = true; a.listenedOn = date; }
      if (review) a.review = a.review ? `${a.review}\n${review}` : review;
      renderKpis(state.albums); render(); openDetail(a.id);
      toast("Enregistré dans Notion ✓");
    } catch (err) {
      toast(err.message, true); btn.disabled = false;
      if (err.auth) { password = ""; store.set("musique:pw", ""); }
    }
  });

  // Pochette : effet « on appuie dessus » qui suit la souris
  function tilt(el) {
    if (!el || !matchMedia("(hover: hover) and (pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.transform = `perspective(800px) rotateX(${(0.5 - y) * 16}deg) rotateY(${(x - 0.5) * 16}deg) scale(.97)`;
      el.style.setProperty("--x", `${x * 100}%`); el.style.setProperty("--y", `${y * 100}%`);
      el.classList.add("pressed");
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; el.classList.remove("pressed"); });
  }

  // ---------- Conseillés pour Thomas ----------
  const spotifySearch = (r) => `https://open.spotify.com/search/${encodeURIComponent(r.artist + " " + r.title)}`;
  function recoCard(r, i, why) {
    const a = { album: r.title, artist: r.artist, cover: r.cover };
    return `<button class="card" data-reco="${i}">
        ${coverHTML(a)}
        <h3>${esc(r.title)}</h3>
        <p>${artistLink(r.artist)}${r.released ? " · " + esc(String(r.released).slice(0, 4)) : ""}</p>
        ${why ? `<p class="why">${esc(why)}</p>` : ""}
      </button>`;
  }
  function recoList() {
    const R = state.reco || { fromArtists: [], picks: [] };
    return [...R.fromArtists.map((r) => ({ ...r, kind: "artist" })), ...R.picks.map((r) => ({ ...r, kind: "pick" }))];
  }
  function renderReco() {
    const R = state.reco;
    if (!R) { els.reco.innerHTML = `<p class="empty">Les conseils arrivent à la prochaine synchro (dans l'heure).</p>`; return; }
    const list = recoList();
    const groups = new Map();
    list.forEach((r, i) => {
      if (r.kind !== "artist") return;
      const g = groups.get(r.artist) || { n: r.heardCount, items: [] };
      g.items.push([r, i]); groups.set(r.artist, g);
    });
    const artistHTML = [...groups.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0], "fr"))
      .map(([name, g]) => `<h4>${artistLink(name)} · ${g.n} albums écoutés</h4><div class="grid">${g.items
        .sort((a, b) => String(b[0].released || "").localeCompare(String(a[0].released || "")))
        .map(([r, i]) => recoCard(r, i)).join("")}</div>`).join("");
    const picksHTML = list.map((r, i) => [r, i]).filter(([r]) => r.kind === "pick").map(([r, i]) => recoCard(r, i, r.why)).join("");
    els.reco.innerHTML = `
      <h2>Ça pourrait te plaire</h2>
      <p class="sub">${R.week ? "Sélection de la semaine, renouvelée chaque lundi d'après les artistes que tu as le mieux notés." : "Ma sélection, d'après tes notes et tes écoutes."}</p>
      <div class="grid">${picksHTML}</div>
      <h2>Tes artistes, albums pas encore écoutés</h2>
      <p class="sub">Albums studio des artistes que tu as écoutés au moins deux fois (sans rééditions, live, compilations ni EP).</p>
      ${artistHTML || `<p class="empty">Rien pour l'instant.</p>`}`;
  }
  function openReco(i) {
    const r = recoList()[i];
    if (!r) return;
    state.current = null;
    const why = r.kind === "pick" ? r.why : `Tu as écouté ${r.heardCount} albums de ${r.artist}, mais pas celui-ci.`;
    $("#detail-body").innerHTML = `
      <div class="d-wrap">
        <div class="d-left">${coverHTML({ album: r.title, artist: r.artist, cover: r.cover }, true)}</div>
        <div class="d-info">
          <h2>${esc(r.title)}</h2>
          <p class="d-artist">${artistLink(r.artist, "a-link big")}</p>
          <span class="chip">Conseillé</span>
          <dl class="meta">
            ${r.released ? `<dt>Sortie</dt><dd>${String(r.released).length > 4 ? fmtRelease(r.released) : esc(r.released)}</dd>` : ""}
            ${r.genre ? `<dt>Genre</dt><dd>${esc(r.genre)}</dd>` : ""}
            ${r.tracks ? `<dt>Titres</dt><dd>${r.tracks}</dd>` : ""}
          </dl>
          <div class="why-box">${esc(why)}</div>
          ${r.url ? `<a class="btn ghost" href="${esc(r.url)}" target="_blank" rel="noopener">${r.url.includes("deezer") ? "Deezer" : "Apple Music"} ↗</a>` : ""}
        </div>
      </div>
      ${goLink(spotifySearch(r), "Chercher sur Spotify")}`;
    const d = $("#detail");
    if (!d.open) d.showModal();
    tilt(d.querySelector(".d-left .cover"));
  }

  // ---------- Stats ----------
  function bars(title, entries, max = Infinity) {
    const rows = entries.slice(0, max);
    const top = Math.max(...rows.map(([, v]) => v), 1);
    return `<div class="panel"><h3>${title}</h3>${rows.map(([k, v]) => `
      <div class="bar"><span title="${esc(k)}">${esc(k)}</span><div class="track"><div class="fill" style="width:${(v / top) * 100}%"></div></div><b>${v}</b></div>`).join("")}</div>`;
  }
  const countBy = (list, fn) => {
    const m = new Map();
    list.forEach((a) => [].concat(fn(a)).filter(Boolean).forEach((k) => m.set(k, (m.get(k) || 0) + 1)));
    return [...m.entries()];
  };

  function renderStats() {
    const heard = state.albums.filter((a) => a.listened);
    const byNote = [5, 4, 3, 2, 1].map((n) => ["★".repeat(n), heard.filter((a) => a.rating === n).length]);
    const byGenre = countBy(heard, (a) => a.genres).sort((a, b) => b[1] - a[1]);
    const byLang = countBy(heard, (a) => a.lang).sort((a, b) => b[1] - a[1]);
    const byYear = countBy(heard.filter((a) => a.listenedOn >= "2025"), (a) => a.listenedOn.slice(0, 7))
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, v]) => [fmtDate(k + "-15", { month: "short", year: "numeric" }), v]);
    const artists = countBy(heard, (a) => a.artist).filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
    const avg = countBy(heard.filter((a) => a.rating), (a) => a.genres).map(([g]) => {
      const l = heard.filter((a) => a.rating && a.genres.includes(g));
      return [g, l.reduce((s, a) => s + a.rating, 0) / l.length];
    }).sort((a, b) => b[1] - a[1]).map(([g, v]) => [g, +v.toFixed(1)]);

    els.stats.innerHTML =
      bars("Répartition des notes", byNote) +
      bars("Genres", byGenre) +
      bars("Note moyenne par genre", avg) +
      bars("Langues", byLang) +
      bars("Écoutes par mois (depuis 2025)", byYear) +
      bars("Artistes les plus écoutés", artists, 12);
  }

  function render() {
    const isArtist = !!state.artist;
    const isStats = !isArtist && state.view === "stats", isReco = !isArtist && state.view === "reco";
    const other = isStats || isReco || isArtist;
    els.filters.hidden = other; els.count.hidden = other; els.grid.hidden = other;
    els.stats.hidden = !isStats; els.reco.hidden = !isReco; els.artist.hidden = !isArtist;
    if (isArtist) return renderArtist();
    if (isReco) return renderReco();
    els.rating.disabled = state.view === "todo" || state.view === "fav";
    isStats ? renderStats() : renderGrid();
  }

  function renderKpis(data) {
    const heard = data.filter((a) => a.listened);
    const k = [
      ["Albums écoutés", heard.length],
      ["Coups de cœur", heard.filter((a) => a.rating === 5).length],
      ["Artistes", new Set(heard.map((a) => a.artist)).size],
      ["À écouter", data.length - heard.length],
    ];
    $("#kpis").innerHTML = k.map(([t, v]) => `<div><dt>${t}</dt><dd>${v}</dd></div>`).join("");
  }

  // Pochettes manquantes : requête iTunes côté navigateur (JSONP)
  function fillCovers() {
    const ids = {};
    state.albums.forEach((a) => {
      if (a.cover || !a.link?.includes("music.apple.com")) return;
      const m = a.link.split("?")[0].match(/\/(\d+)\/?$/);
      if (m) (ids[m[1]] ||= []).push(a);
    });
    const keys = Object.keys(ids);
    if (!keys.length) return;
    window.__itunesCb = (data) => {
      (data.results || []).forEach((it) => {
        (ids[it.collectionId] || []).forEach((a) => { a.cover = it.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/600x600bb."); });
      });
      render();
    };
    const s = document.createElement("script");
    s.src = `https://itunes.apple.com/lookup?id=${keys.join(",")}&country=fr&callback=__itunesCb`;
    document.body.appendChild(s);
  }

  // ---------- Données à jour sans attendre la synchro ----------
  // Le site publié est régénéré toutes les heures. En attendant, on lit Notion en direct via
  // la fonction Cloudflare et on applique les changements (écoutés, notes, avis, nouveaux albums).
  async function liveSync() {
    if (!API) return;
    let data;
    try { data = await fetch(API + "/export").then((r) => (r.ok ? r.json() : Promise.reject())); } catch { return; }
    const live = (data.albums || []).filter((x) => x.album && x.artist);
    if (!live.length) return;
    const byId = new Map(state.albums.map((a) => [a.id, a]));
    const heardKeys = new Set(live.filter((x) => x.listened).map((x) => norm(`${x.artist}|${x.album}`)));
    const next = [];
    for (const x of live) {
      const a = byId.get(x.id);
      if (!x.listened && heardKeys.has(norm(`${x.artist}|${x.album}`))) continue;
      if (a) {
        Object.assign(a, { listened: x.listened, listenedOn: x.listenedOn, rating: x.rating, lang: x.lang, link: x.link || a.link, released: x.released || a.released, album: x.album });
        next.push(a);
      } else {
        next.push({ id: x.id, album: x.album, artist: x.artist, genres: x.genres || [], lang: x.lang, rating: x.rating,
          listened: x.listened, listenedOn: x.listenedOn, released: x.released, link: x.link, cover: x.cover || x.coverFile || null });
      }
    }
    state.albums = next;
    refresh();
    // Avis : la fonction ne relit que les fiches modifiées depuis la dernière fois
    try {
      const ids = data.ids || [];
      for (let i = 0; i < ids.length; i += 50) {
        const r = await fetch(`${API}/export/reviews?ids=${encodeURIComponent(ids.slice(i, i + 50).join(","))}`).then((x) => x.json());
        for (const [id, text] of Object.entries(r.reviews || {})) {
          const a = state.albums.find((x) => x.id === id);
          if (a) a.review = text || undefined;
        }
      }
      refresh();
    } catch { /* les avis publiés restent affichés */ }
  }
  function refresh() {
    renderKpis(state.albums);
    if (!$("#detail").open) render();
  }

  // ---------- Événements ----------
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    state.view = b.dataset.view; state.artist = null;
    render();
  }));
  ["input", "change"].forEach((ev) => els.filters.addEventListener(ev, render));
  function onCards(e) {
    const art = e.target.closest("[data-artist]");
    if (art) return showArtist(art.dataset.artist);
    if (e.target.closest("[data-back]")) {
      state.artist = null;
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x.dataset.view === state.view));
      return render();
    }
    const c = e.target.closest(".card");
    if (!c) return;
    if (c.dataset.id) openDetail(c.dataset.id); else openReco(+c.dataset.reco);
  }
  [els.grid, els.reco, els.artist].forEach((el) => {
    el.addEventListener("click", onCards);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-artist]")) { e.preventDefault(); onCards(e); } });
  });
  $("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") e.target.close(); });

  // ---------- Chargement ----------
  function load() {
    fetch("data/conseils.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { state.reco = d; if (state.view === "reco" || state.artist) render(); } })
      .catch(() => {});
    fetch("data/albums.json", { cache: "no-cache" })
      .then((r) => r.json())
      .then((data) => {
        state.albums = data.albums;
        const genres = [...new Set(data.albums.flatMap((a) => a.genres))].sort((a, b) => a.localeCompare(b, "fr"));
        const langs = [...new Set(data.albums.map((a) => a.lang).filter(Boolean))].sort();
        els.genre.insertAdjacentHTML("beforeend", genres.map((g) => `<option>${esc(g)}</option>`).join(""));
        els.lang.insertAdjacentHTML("beforeend", langs.map((l) => `<option>${esc(l)}</option>`).join(""));
        $("#updated").textContent = "mis à jour le " + new Date(data.updatedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
        renderKpis(data.albums);
        render();
        fillCovers();
        liveSync();
      })
      .catch(() => { els.grid.innerHTML = `<p class="empty">Impossible de charger les données.</p>`; });
  }

  checkAccess();
})();
