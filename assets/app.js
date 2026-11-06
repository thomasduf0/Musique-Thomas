(() => {
  const $ = (s) => document.querySelector(s);
  const API = (window.MUSIQUE_API || "").replace(/\/$/, "");
  const state = { view: "all", albums: [], reco: null, artist: null, current: null, pending: null, dismissed: new Set() };
  const els = {
    grid: $("#grid"), stats: $("#stats"), reco: $("#reco"), artist: $("#artist"), filters: $("#filters"), count: $("#count"),
    genre: $("#genre"), lang: $("#lang"), rating: $("#rating"), sort: $("#sort"),
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d, opts = { day: "numeric", month: "short", year: "numeric" }) =>
    d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", opts) : "—";
  // Une date au 1er janvier vient en général d'une année seule : on n'affiche que l'année
  const fmtRelease = (d) => (d && /-01-01$/.test(d) ? d.slice(0, 4) : fmtDate(d));
  const stars = (n) => n ? `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>` : `<span class="chip">Non noté</span>`;
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  // Clé d'un conseil (identique à scripts/build-data.mjs)
  const flatK = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[\(\[][^\)\]]*[\)\]]/g, "").replace(/[^a-z0-9]+/g, "");
  const recoKey = (r) => `${flatK(r.artist)}|${flatK(r.title)}`;
  const GENRES = ["Pop", "Hip-hop/Rap", "Electro", "Rock", "Country", "Funk", "Alternative", "Gospel"];
  const LANGS = ["Français", "Anglais", "Espagnol"];
  const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());

  function toast(msg, err = false, undo = null) {
    const t = $("#toast"), d = $("#detail");
    (d.open ? d : document.body).appendChild(t); // au-dessus de la fiche ouverte
    t.textContent = msg; t.className = "toast show" + (err ? " err" : "") + (undo ? " has-action" : "");
    if (undo) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "Annuler";
      b.onclick = () => { t.className = "toast"; undo(); };
      t.append(" ", b);
    }
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = "toast"), undo ? 7000 : 4000);
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
    const g = els.genre.value, l = els.lang.value, r = +els.rating.value;
    let list = state.albums.filter((a) =>
      state.view === "todo" ? !a.listened :
      state.view === "fav" ? a.listened && a.rating === 5 : a.listened);
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
        ${a.listened ? "" : `<span class="pills"><span class="pill-btn" role="button" tabindex="0" data-heard="${a.id}">✓ Écouté</span></span>`}
      </button>`;

  function renderGrid() {
    const list = currentList();
    const s = list.length > 1 ? "s" : "";
    els.count.textContent = `${list.length} album${s}${state.view === "todo" ? " à écouter" : ""}`;
    if (!list.length) { els.grid.innerHTML = `<p class="empty">Aucun album ne correspond à ces filtres.</p>`; return; }
    els.grid.replaceChildren(...list.map(cardEl));
  }
  // On garde les cartes déjà construites : une carte identique n'est pas recréée, donc sa pochette ne recharge pas
  const cardCache = new Map();
  function cardEl(a) {
    const html = albumCard(a).trim(), c = cardCache.get(a.id);
    if (c && c.html === html) return c.el;
    const t = document.createElement("template");
    t.innerHTML = html;
    const el = t.content.firstElementChild;
    cardCache.set(a.id, { html, el });
    return el;
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

  function openDetail(id, edit = false) {
    const a = state.albums.find((x) => x.id === id);
    if (!a) return;
    state.current = a; state.pending = null;
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
          <button class="btn ${a.listened ? "ghost " : ""}edit-btn" type="button" data-edit>${a.listened ? "Modifier" : "✓ Écouté"}</button>
          ${editForm(a)}
        </div>
      </div>
      ${goLink(a.link, linkLabel(a.link))}`;
    const d = $("#detail");
    if (!d.open) d.showModal();
    tilt(d.querySelector(".d-left .cover"));
    if (edit) openEdit();
  }
  function openEdit() {
    const form = $("#detail-body .edit"), btn = $("#detail-body [data-edit]");
    if (!form) return;
    form.hidden = false; btn.hidden = true;
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
    return heardForm(a, true);
  }
  function heardForm(a, hidden) {
    const mine = a.myGenres || a.genres || [];
    const langs = [...new Set([...LANGS, a.lang].filter(Boolean))];
    return `<form class="edit"${hidden ? " hidden" : ""}>
      <p class="edit-title">Je l'ai écouté</p>
      <div class="field"><span>Ma note</span>${rateHTML(0)}</div>
      <label>Date d'écoute<input name="date" type="date" value="${today()}"></label>
      <label>Mon avis<textarea name="review" rows="4" placeholder="Facultatif"></textarea></label>
      <label>Langue<select name="lang"><option value="">—</option>${langs.map((l) => `<option${l === a.lang ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <fieldset class="genres"><legend>Genres</legend>${GENRES.map((g) =>
        `<label><input type="checkbox" name="genre" value="${g}"${mine.includes(g) ? " checked" : ""}><span>${g}</span></label>`).join("")}</fieldset>
      <div class="btns"><button class="btn">Enregistrer</button><button class="btn ghost" type="button" data-cancel>Annuler</button></div>
    </form>`;
  }

  $("#detail-body").addEventListener("click", (e) => {
    const art = e.target.closest("[data-artist]");
    if (art) { $("#detail").close(); return showArtist(art.dataset.artist); }
    if (e.target.closest("[data-reroll]")) return openRandom();
    const rm = e.target.closest("[data-rmode]");
    if (rm) return openRandom(rm.dataset.rmode);
    const oid = e.target.closest("[data-open-id]");
    if (oid) return openDetail(oid.dataset.openId);
    const rh = e.target.closest("[data-reco-heard]");
    if (rh) return recoHeard(+rh.dataset.recoHeard, rh);
    const rt = e.target.closest("[data-reco-todo]");
    if (rt) return recoTodo(+rt.dataset.recoTodo, rt);
    if (e.target.closest("[data-cancel]") && state.pending) { $("#detail").close(); return; }
    const form = $("#detail-body .edit");
    if (e.target.closest("[data-edit]")) { openEdit(); return; }
    const nope = e.target.closest("[data-nope]");
    if (nope) { dismiss(+nope.dataset.nope); $("#detail").close(); return; }
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
    if (state.pending) return saveNew(state.pending, { listened: true, rating, listenedOn: date, review: text,
      lang: form.lang.value || null, genres: [...form.querySelectorAll("input[name=genre]:checked")].map((c) => c.value) }, form.querySelector("button:not([type])"));
    const body = {};
    let review = "";
    if (a.listened) {
      if (rating !== (a.rating || null)) body.rating = rating;
      if (text) review = `${nextListen(a.review)}e écoute (${fmtDate(date)})\n${text}`;
    } else {
      const genres = [...form.querySelectorAll("input[name=genre]:checked")].map((c) => c.value);
      Object.assign(body, { listened: true, listenedOn: date, rating, lang: form.lang.value || null, genres });
      review = text;
    }
    if (review) body.review = review;
    if (!Object.keys(body).length) return toast("Rien à enregistrer", true);
    const btn = form.querySelector("button:not([type])"); btn.disabled = true;
    try {
      await api(`/albums/${a.id}`, { method: "PATCH", body: JSON.stringify(body) });
      if ("rating" in body) a.rating = body.rating;
      if (body.listened) { a.listened = true; a.listenedOn = date; a.lang = body.lang; a.myGenres = body.genres; }
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
        <span class="pills">
          <span class="pill-btn" role="button" tabindex="0" data-reco-heard="${i}">✓ Écouté</span>
          <span class="pill-btn ghost" role="button" tabindex="0" data-nope="${i}">Pas intéressé</span>
        </span>
      </button>`;
  }
  function recoList() {
    const R = state.reco || { fromArtists: [], picks: [] };
    return [...R.fromArtists.map((r) => ({ ...r, kind: "artist" })), ...R.picks.map((r) => ({ ...r, kind: "pick" }))]
      .filter((r) => !state.dismissed.has(recoKey(r)) && !inBase(r.artist, r.title));
  }
  // Déjà dans la base (ajouté depuis le site) : on ne le conseille plus
  function inBase(artist, title) {
    const k = recoKey({ artist, title });
    return state.albums.some((a) => recoKey({ artist: a.artist, title: a.album }) === k);
  }

  // « Pas intéressé » : enregistré dans la fonction Cloudflare (et dans ce navigateur en attendant)
  const saveDismissed = () => store.set("musique:dismissed", JSON.stringify([...state.dismissed]));
  async function dismiss(i) {
    const r = recoList()[i];
    if (!r) return;
    const key = recoKey(r);
    state.dismissed.add(key); saveDismissed(); render();
    const send = (undo) => api("/dismissed", { method: "POST", body: JSON.stringify({ key, artist: r.artist, title: r.title, undo }) });
    toast(`« ${r.title} » ne te sera plus proposé`, false, async () => {
      state.dismissed.delete(key); saveDismissed(); render();
      try { await send(true); } catch {}
    });
    try { await send(false); } catch (err) { if (err.auth) toast(err.message, true); }
  }
  async function loadDismissed() {
    try { JSON.parse(store.get("musique:dismissed") || "[]").forEach((k) => state.dismissed.add(k)); } catch {}
    if (!API) return;
    try {
      const d = await fetch(API + "/dismissed").then((r) => (r.ok ? r.json() : Promise.reject()));
      (d.dismissed || []).forEach((x) => state.dismissed.add(x.key));
      saveDismissed();
      if (state.view === "reco" || state.artist) render();
    } catch { /* la liste locale suffit */ }
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
    state.current = null; state.pending = null;
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
          <div class="btns">
            <button class="btn" type="button" data-reco-heard="${i}">✓ Écouté</button>
            <button class="btn ghost" type="button" data-reco-todo="${i}">+ À écouter</button>
            <button class="btn ghost" type="button" data-nope="${i}">Pas intéressé</button>
          </div>
        </div>
      </div>
      ${goLink(spotifySearch(r), "Chercher sur Spotify")}`;
    const d = $("#detail");
    if (!d.open) d.showModal();
    tilt(d.querySelector(".d-left .cover"));
  }

  // ---------- Ajouter un album à la base (depuis la recherche ou un conseil) ----------
  const spotifyId = (l) => l?.match(/album\/([A-Za-z0-9]+)/)?.[1];
  function findInBase(r) {
    const id = spotifyId(r.link);
    return state.albums.find((a) => (id && spotifyId(a.link) === id) || recoKey({ artist: a.artist, title: a.album }) === recoKey({ artist: r.artist, title: r.album }));
  }
  function openNew(r) {
    state.current = null; state.pending = r;
    $("#detail-body").innerHTML = `
      <div class="d-wrap">
        <div class="d-left">${coverHTML({ album: r.album, artist: r.artist, cover: r.cover }, true)}</div>
        <div class="d-info">
          <h2>${esc(r.album)}</h2>
          <p class="d-artist">${esc(r.artist)}</p>
          <dl class="meta">${r.released ? `<dt>Sortie</dt><dd>${fmtRelease(r.released)}</dd>` : ""}</dl>
          ${heardForm({ album: r.album, genres: r.genres || [] }, false)}
        </div>
      </div>
      ${goLink(r.link, "Écouter sur Spotify")}`;
    const d = $("#detail");
    if (!d.open) d.showModal();
    tilt(d.querySelector(".d-left .cover"));
  }
  async function saveNew(r, extra, btn) {
    if (btn) btn.disabled = true;
    const body = { album: r.album, artist: r.artist, released: r.released || null, link: r.link || null, cover: r.cover || null,
      genres: r.genres || [], lang: null, listened: false, ...extra };
    try {
      const res = await api("/albums", { method: "POST", body: JSON.stringify(body) });
      const a = { id: res.id.replace(/-/g, ""), album: body.album, artist: body.artist, genres: body.genres, myGenres: body.genres, lang: body.lang,
        rating: body.listened ? body.rating || null : null, listened: !!body.listened, listenedOn: body.listened ? body.listenedOn : null,
        released: body.released, link: body.link, cover: body.cover, review: body.review || undefined };
      state.albums.push(a); state.pending = null;
      renderKpis(state.albums); render();
      if (body.listened) openDetail(a.id); else if ($("#detail").open) $("#detail").close();
      toast(body.listened ? "Ajouté à tes écoutes ✓" : `« ${a.album} » ajouté à « À écouter » ✓`);
      return a;
    } catch (err) {
      toast(err.message, true); if (btn) btn.disabled = false;
      return null;
    }
  }
  // Un conseil vient d'Apple Music : on retrouve l'album sur Spotify pour le lien et la pochette
  async function onSpotify(r) {
    let best = null;
    try {
      const { results } = await api(`/search?album=${encodeURIComponent(r.title)}&artist=${encodeURIComponent(r.artist)}`);
      const t = flatK(r.title), ar = flatK(r.artist);
      const same = results.filter((x) => flatK(x.artist).includes(ar) || ar.includes(flatK(x.mainArtist)));
      best = same.find((x) => flatK(x.album) === t) || same.find((x) => flatK(x.album).startsWith(t) || t.startsWith(flatK(x.album))) || null;
    } catch {}
    return best ? { album: best.album, artist: best.mainArtist || r.artist, released: best.released, link: best.link, cover: best.cover || r.cover, genres: best.genres || [] }
      : { album: r.title, artist: r.artist, released: r.released && String(r.released).length > 4 ? r.released : null, cover: r.cover, genres: [] };
  }
  async function recoHeard(i, el) {
    const r = recoList()[i]; if (!r) return;
    el.setAttribute("aria-busy", "true"); el.classList.add("busy");
    openNew(await onSpotify(r));
  }
  async function recoTodo(i, el) {
    const r = recoList()[i]; if (!r) return;
    el.disabled = true;
    await saveNew(await onSpotify(r), { listened: false }, el);
  }

  // ---------- Recherche (en-tête) : ta base + Spotify ----------
  // Ta base s'affiche instantanément à chaque frappe ; Spotify arrive ensuite (une seule requête,
  // mise en cache, les requêtes devenues inutiles sont annulées) sans effacer les résultats affichés.
  const sInput = $("#search"), sBox = $("#sresults");
  let sTimer = 0, sSpotify = [], sAbort = null, sShown = { q: "", list: null };
  const sCache = new Map(); // requête normalisée → résultats Spotify
  const thumb = (src, alt = "") => src ? `<img src="${esc(fixCover(src))}" alt="${esc(alt)}" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="ph-s"></span>`;
  function closeSearch() { sBox.hidden = true; }
  function localMatches(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const score = (a) => {
      const al = norm(a.album), ar = norm(a.artist), all = `${al} ${ar}`;
      if (!words.every((w) => all.includes(w))) return -1;
      const k = words.join(" ");
      return (al === k || ar === k ? 4 : 0) + (al.startsWith(k) || ar.startsWith(k) ? 2 : 0)
        + words.filter((w) => all.split(/\s+/).some((t) => t.startsWith(w))).length / words.length;
    };
    return state.albums.map((a) => [a, score(a)]).filter(([, s]) => s >= 0)
      .sort((x, y) => (y[1] - x[1]) || (y[0].listened - x[0].listened) || (y[0].listenedOn || "").localeCompare(x[0].listenedOn || ""))
      .slice(0, 6).map(([a]) => a);
  }
  function renderSearch(q, spotify, loading) {
    const local = localMatches(q);
    const ext = (spotify || []).filter((r) => !findInBase(r)).slice(0, 8);
    sSpotify = ext;
    const keepFocus = sBox.contains(document.activeElement) ? [...sBox.querySelectorAll(".srow")].indexOf(document.activeElement.closest(".srow")) : -1;
    sBox.innerHTML = `
      ${local.length ? `<h4>Dans ton journal</h4>${local.map((a) => `
        <div class="srow local" role="button" tabindex="0" data-open="${a.id}">
          ${thumb(a.cover || a.coverAlt)}
          <div><b>${esc(a.album)}</b><span>${esc(a.artist)}${a.released ? " · " + esc(a.released.slice(0, 4)) : ""}</span></div>
          <span class="tag${a.listened ? " heard" : ""}">${a.listened ? (a.rating ? "★".repeat(a.rating) : "Écouté") : "À écouter"}</span>
        </div>`).join("")}` : ""}
      <h4>Sur Spotify${loading ? ` <span class="s-spin" aria-label="Recherche en cours"></span>` : ""}</h4>
      ${ext.length ? `<div class="s-ext${loading ? " stale" : ""}">${ext.map((r, i) => `
        <div class="srow" tabindex="-1">
          ${thumb(r.thumb || r.cover)}
          <div><b>${esc(r.album)}</b><span>${esc(r.artist)}${r.released ? " · " + esc(r.released.slice(0, 4)) : ""}${r.type && r.type !== "album" ? " · " + esc(r.type) : ""}</span></div>
          <div class="acts">
            <button class="mini-btn primary" type="button" data-s-heard="${i}">✓ Écouté</button>
            <button class="mini-btn" type="button" data-s-todo="${i}">+ À écouter</button>
          </div>
        </div>`).join("")}</div>`
        : loading ? `<p class="hint">Recherche…</p>`
        : `<p class="hint">${spotify ? (local.length ? "Rien de plus sur Spotify." : "Aucun résultat.") : "Spotify indisponible pour le moment."}</p>`}`;
    sBox.hidden = false;
    if (keepFocus >= 0) sBox.querySelectorAll(".srow")[keepFocus]?.focus();
  }
  async function fetchSpotify(q) {
    const key = norm(q);
    if (sCache.has(key)) return sCache.get(key);
    sAbort?.abort();
    const ctrl = sAbort = new AbortController();
    const { results = [] } = await api(`/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
    sCache.set(key, results);
    if (sCache.size > 60) sCache.delete(sCache.keys().next().value);
    return results;
  }
  async function runSearch() {
    const q = sInput.value.trim();
    if (q.length < 2) return;
    const key = norm(q);
    if (sCache.has(key)) { sShown = { q: key, list: sCache.get(key) }; return renderSearch(q, sShown.list, false); }
    try {
      const list = await fetchSpotify(q);
      if (norm(sInput.value.trim()) !== key) return; // l'utilisateur a continué à taper
      sShown = { q: key, list };
      renderSearch(q, list, false);
    } catch (err) {
      if (err.name === "AbortError") return;
      if (norm(sInput.value.trim()) === key) renderSearch(q, null, false);
    }
  }
  function onType() {
    clearTimeout(sTimer);
    const q = sInput.value.trim();
    if (q.length < 2) { sAbort?.abort(); return closeSearch(); }
    const key = norm(q), cached = sCache.get(key);
    // Affichage immédiat : ta base + les derniers résultats Spotify (estompés) en attendant les nouveaux
    renderSearch(q, cached || sShown.list || [], !cached);
    if (cached) { sShown = { q: key, list: cached }; return; }
    sTimer = setTimeout(runSearch, 220);
  }
  sInput.addEventListener("input", onType);
  sInput.addEventListener("focus", () => { if (sInput.value.trim().length >= 2 && sBox.innerHTML) sBox.hidden = false; });
  // Navigation au clavier : ↓/↑ parcourent les résultats, Entrée ouvre, Échap ferme
  const sRows = () => [...sBox.querySelectorAll(".srow")];
  function moveFocus(dir) {
    const rows = sRows(); if (!rows.length) return;
    const i = rows.indexOf(document.activeElement.closest?.(".srow"));
    const next = i + dir;
    if (next < 0) return sInput.focus();
    rows[Math.min(next, rows.length - 1)].focus();
  }
  sInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSearch(); sInput.blur(); }
    if (e.key === "ArrowDown" && !sBox.hidden) { e.preventDefault(); moveFocus(1); }
    if (e.key === "Enter") {
      e.preventDefault(); clearTimeout(sTimer);
      const first = sBox.hidden ? null : sBox.querySelector("[data-open]");
      if (first) first.click(); else runSearch();
    }
  });
  sBox.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(-1); }
    else if (e.key === "Escape") { closeSearch(); sInput.focus(); }
    else if (e.key === "Enter" && e.target.matches("[data-open]")) e.target.click();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) closeSearch(); });
  sBox.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { closeSearch(); return openDetail(open.dataset.open); }
    const h = e.target.closest("[data-s-heard]");
    if (h) { closeSearch(); const r = sSpotify[+h.dataset.sHeard]; return openNew({ ...r, artist: r.mainArtist || r.artist }); }
    const t = e.target.closest("[data-s-todo]");
    if (t) {
      const r = sSpotify[+t.dataset.sTodo];
      const a = await saveNew({ ...r, artist: r.mainArtist || r.artist }, { listened: false }, t);
      if (a) renderSearch(sInput.value.trim(), sShown.list, false);
    }
  });

  // ---------- Écoute aléatoire : un album noté 4★ ou 5★, ou un album « À écouter » ----------
  const recent = [];
  function randomPick(mode) {
    const pool = state.albums.filter((a) =>
      (mode !== "todo" && a.listened && a.rating >= 4) || (mode !== "fav" && !a.listened));
    if (!pool.length) return null;
    const fresh = pool.filter((a) => !recent.includes(a.id));
    const from = fresh.length ? fresh : pool;
    const a = from[Math.floor(Math.random() * from.length)];
    recent.push(a.id); if (recent.length > Math.min(20, pool.length - 1)) recent.shift();
    return a;
  }
  function openRandom(mode = state.randomMode || "all") {
    state.randomMode = mode;
    const a = randomPick(mode);
    state.current = null; state.pending = null;
    const modes = [["all", "Tout"], ["fav", "Mes 4★ et 5★"], ["todo", "À écouter"]];
    const why = !a ? "" : a.listened
      ? `Tu lui as mis ${a.rating}★${a.listenedOn ? `, écouté le ${fmtDate(a.listenedOn)}` : ""}.`
      : "Dans ta liste « À écouter ».";
    $("#detail-body").innerHTML = `
      <div class="d-wrap random">
        <div class="d-left">${a ? coverHTML(a, true) : ""}</div>
        <div class="d-info">
          <p class="eyebrow">🎲 Écoute aléatoire</p>
          <div class="seg-mini" role="radiogroup" aria-label="Choisir parmi">${modes.map(([v, l]) =>
            `<button type="button" role="radio" aria-checked="${v === mode}" data-rmode="${v}">${l}</button>`).join("")}</div>
          ${a ? `<h2>${esc(a.album)}</h2>
          <p class="d-artist">${artistLink(a.artist, "a-link big")}</p>
          <div class="why-box">${esc(why)}</div>
          <div class="btns">
            <button class="btn" type="button" data-reroll>Autre proposition</button>
            <button class="btn ghost" type="button" data-open-id="${a.id}">Voir la fiche</button>
          </div>` : `<p class="empty">Aucun album ne correspond.</p>`}
        </div>
      </div>
      ${a ? goLink(a.link, linkLabel(a.link)) : ""}`;
    const d = $("#detail");
    if (!d.open) d.showModal();
    tilt(d.querySelector(".d-left .cover"));
  }
  $("#random-btn").addEventListener("click", () => openRandom());

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
        Object.assign(a, { myGenres: x.genres || a.myGenres, listened: x.listened, listenedOn: x.listenedOn, rating: x.rating, lang: x.lang, link: x.link || a.link, released: x.released || a.released, album: x.album });
        next.push(a);
      } else {
        next.push({ id: x.id, album: x.album, artist: x.artist, genres: x.genres || [], myGenres: x.genres || [], lang: x.lang, rating: x.rating,
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
    const nope = e.target.closest("[data-nope]");
    if (nope) return dismiss(+nope.dataset.nope);
    const rh = e.target.closest("[data-reco-heard]");
    if (rh) return recoHeard(+rh.dataset.recoHeard, rh);
    const heard = e.target.closest("[data-heard]");
    if (heard) return openDetail(heard.dataset.heard, true);
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
    el.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-artist], [data-nope], [data-heard], [data-reco-heard]")) { e.preventDefault(); onCards(e); } });
  });
  $("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") e.target.close(); });

  // ---------- Chargement ----------
  function load() {
    loadDismissed();
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
