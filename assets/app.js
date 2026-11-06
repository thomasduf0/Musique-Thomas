(() => {
  const $ = (s) => document.querySelector(s);
  const state = { view: "all", albums: [], reco: null };
  const els = {
    grid: $("#grid"), stats: $("#stats"), reco: $("#reco"), filters: $("#filters"), count: $("#count"),
    q: $("#q"), genre: $("#genre"), lang: $("#lang"), rating: $("#rating"), sort: $("#sort"),
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d, opts = { day: "numeric", month: "short", year: "numeric" }) =>
    d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", opts) : "—";
  const stars = (n) => n ? `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>` : `<span class="chip">Non noté</span>`;
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // Couleur de repli stable par album (si pas de pochette)
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
    return `<div class="cover">${ph}${img}${badge}</div>`;
  }

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

  function renderGrid() {
    const list = currentList();
    const s = list.length > 1 ? "s" : "";
    els.count.textContent = `${list.length} album${s}${state.view === "todo" ? " à écouter" : ""}`;
    els.grid.innerHTML = list.length ? list.map((a) => `
      <button class="card" data-id="${a.id}">
        ${coverHTML(a)}
        <h3>${esc(a.album)}</h3>
        <p>${esc(a.artist)}</p>
        <p>${a.listened ? "Écouté le " + fmtDate(a.listenedOn) : "Sortie : " + fmtDate(a.released)}</p>
      </button>`).join("") : `<p class="empty">Aucun album ne correspond à ces filtres.</p>`;
  }

  function openDetail(id) {
    const a = state.albums.find((x) => x.id === id);
    if (!a) return;
    const linkLabel = a.link?.includes("spotify") ? "Écouter sur Spotify" : a.link?.includes("qobuz") ? "Écouter sur Qobuz" : "Écouter sur Apple Music";
    $("#detail-body").innerHTML = `
      <div class="d-wrap">
        ${coverHTML(a, true)}
        <div class="d-info">
          <h2>${esc(a.album)}</h2>
          <p class="d-artist">${esc(a.artist)}</p>
          ${a.listened ? stars(a.rating) : `<span class="chip">À écouter</span>`}
          <dl class="meta">
            <dt>Sortie</dt><dd>${fmtDate(a.released)}</dd>
            ${a.listened ? `<dt>Écouté le</dt><dd>${fmtDate(a.listenedOn)}</dd>` : ""}
            ${a.lang ? `<dt>Langue</dt><dd>${esc(a.lang)}</dd>` : ""}
          </dl>
          <div class="chips" title="Genre Apple Music">${a.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>
          ${a.review ? `<div class="review">${esc(a.review)}</div>` : ""}
          ${a.link ? `<a class="btn" href="${esc(a.link)}" target="_blank" rel="noopener">${linkLabel} ↗</a>` : ""}
        </div>
      </div>`;
    $("#detail").showModal();
  }

  // ---------- Conseillés pour Thomas ----------
  const spotifySearch = (r) => `https://open.spotify.com/search/${encodeURIComponent(r.artist + " " + r.title)}`;
  function recoCard(r, i, why) {
    const a = { album: r.title, artist: r.artist, cover: r.cover };
    return `<button class="card" data-reco="${i}">
        ${coverHTML(a)}
        <h3>${esc(r.title)}</h3>
        <p>${esc(r.artist)}${r.released ? " · " + esc(String(r.released).slice(0, 4)) : ""}</p>
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
      .map(([name, g]) => `<h4>${esc(name)} · ${g.n} albums écoutés</h4><div class="grid">${g.items
        .sort((a, b) => String(b[0].released || "").localeCompare(String(a[0].released || "")))
        .map(([r, i]) => recoCard(r, i)).join("")}</div>`).join("");
    const picksHTML = list.map((r, i) => [r, i]).filter(([r]) => r.kind === "pick").map(([r, i]) => recoCard(r, i, r.why)).join("");
    els.reco.innerHTML = `
      <h2>Ça pourrait te plaire</h2>
      <p class="sub">Ma sélection, d'après tes notes et tes écoutes.</p>
      <div class="grid">${picksHTML}</div>
      <h2>Tes artistes, albums pas encore écoutés</h2>
      <p class="sub">Albums studio des artistes que tu as écoutés au moins deux fois (sans rééditions, live, compilations ni EP).</p>
      ${artistHTML || `<p class="empty">Rien pour l'instant.</p>`}`;
  }
  function openReco(i) {
    const r = recoList()[i];
    if (!r) return;
    const why = r.kind === "pick" ? r.why : `Tu as écouté ${r.heardCount} albums de ${r.artist}, mais pas celui-ci.`;
    $("#detail-body").innerHTML = `
      <div class="d-wrap">
        ${coverHTML({ album: r.title, artist: r.artist, cover: r.cover }, true)}
        <div class="d-info">
          <h2>${esc(r.title)}</h2>
          <p class="d-artist">${esc(r.artist)}</p>
          <span class="chip">Conseillé</span>
          <dl class="meta">
            ${r.released ? `<dt>Sortie</dt><dd>${String(r.released).length > 4 ? fmtDate(r.released) : esc(r.released)}</dd>` : ""}
            ${r.genre ? `<dt>Genre</dt><dd>${esc(r.genre)}</dd>` : ""}
            ${r.tracks ? `<dt>Titres</dt><dd>${r.tracks}</dd>` : ""}
          </dl>
          <div class="why-box">${esc(why)}</div>
          <div class="btns">
            <a class="btn" href="${esc(spotifySearch(r))}" target="_blank" rel="noopener">Chercher sur Spotify ↗</a>
            ${r.url ? `<a class="btn ghost" href="${esc(r.url)}" target="_blank" rel="noopener">Apple Music ↗</a>` : ""}
          </div>
        </div>
      </div>`;
    $("#detail").showModal();
  }

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
    const isStats = state.view === "stats", isReco = state.view === "reco", other = isStats || isReco;
    els.filters.hidden = other; els.count.hidden = other; els.grid.hidden = other;
    els.stats.hidden = !isStats; els.reco.hidden = !isReco;
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

  // ---------- Événements ----------
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    state.view = b.dataset.view;
    render();
  }));
  ["input", "change"].forEach((ev) => els.filters.addEventListener(ev, render));
  els.grid.addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openDetail(c.dataset.id); });
  els.reco.addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openReco(+c.dataset.reco); });
  $("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") e.target.close(); });

  // ---------- Chargement ----------
  fetch("data/conseils.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) { state.reco = d; if (state.view === "reco") render(); } })
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
    })
    .catch(() => { els.grid.innerHTML = `<p class="empty">Impossible de charger les données.</p>`; });
})();
