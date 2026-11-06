(() => {
  const $ = (s) => document.querySelector(s);
  const API = (window.MUSIQUE_API || "").replace(/\/$/, "");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());

  let password = "";
  try { password = localStorage.getItem("musique:pw") || ""; } catch {}

  function toast(msg, err = false) {
    const t = $("#toast");
    t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = "toast"), 4000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", "X-Password": password, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error("Mot de passe incorrect"); }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  function logout() {
    password = "";
    try { localStorage.removeItem("musique:pw"); } catch {}
    $("#app").hidden = true; $("#login").hidden = false;
  }

  // ---------- Démarrage ----------
  async function start() {
    if (!API) {
      $("#status").textContent = "La fonction Cloudflare n'est pas encore configurée (assets/config.js).";
      return;
    }
    if (!password) { $("#login").hidden = false; return; }
    try {
      const s = await api("/status");
      $("#login").hidden = true; $("#app").hidden = false;
      const linkUrl = `${API}/spotify/login?password=${encodeURIComponent(password)}`;
      const last = s.lastCheck?.at ? ` · dernière vérification ${new Date(s.lastCheck.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}` : "";
      $("#status").innerHTML = s.spotifyLinked
        ? `Spotify relié : les albums écoutés en entier sont cochés automatiquement${esc(last)}.`
        : `Spotify n'est pas encore relié pour la détection d'écoute. <a href="${esc(linkUrl)}" style="color:var(--accent)">Relier mon compte Spotify</a>`;
      loadToRate();
    } catch (e) {
      toast(e.message, true);
    }
  }

  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    password = $("#password").value;
    try { localStorage.setItem("musique:pw", password); } catch {}
    start();
  });

  // Albums : données publiées + état en direct de Notion (sans attendre la synchro horaire)
  let albumsP = null;
  function loadAlbums(fresh = false) {
    if (albumsP && !fresh) return albumsP;
    albumsP = (async () => {
      const base = await fetch("data/albums.json", { cache: "no-cache" }).then((r) => r.json()).then((d) => d.albums).catch(() => []);
      try {
        const live = (await fetch(API + "/export").then((r) => (r.ok ? r.json() : Promise.reject()))).albums.filter((x) => x.album && x.artist);
        const byId = new Map(base.map((a) => [a.id, a]));
        return live.map((x) => {
          const b = byId.get(x.id) || {};
          return { ...b, ...x, cover: b.cover || x.cover || x.coverFile || null, genres: b.genres || x.genres || [] };
        });
      } catch { return base; }
    })();
    return albumsP;
  }

  function paintStars(container, n) {
    container.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v <= n));
  }

  // ---------- Apparence ----------
  const pref = window.getThemePref ? window.getThemePref() : "dark";
  document.querySelectorAll("#theme input").forEach((r) => {
    r.checked = r.value === pref;
    r.addEventListener("change", () => { window.setTheme?.(r.value); toast("Thème enregistré ✓"); });
  });

  // ---------- À noter ----------
  const fmt = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "";
  const starsHTML = () => `<div class="rate" aria-label="Note">${[1, 2, 3, 4, 5].map((v) => `<button type="button" data-v="${v}">★</button>`).join("")}</div>`;
  function rowHTML({ key, cover, album, artist, when, extra = "", actions }) {
    return `<div class="todo-item" data-key="${esc(key)}" data-rating="0">
      ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="ph-mini" style="background:var(--line)"></div>`}
      <div><b>${esc(album)}</b><span>${esc(artist)}${extra}</span><span class="when">${esc(when)}</span></div>
      <div class="actions">${starsHTML()}${actions}</div>
    </div>`;
  }
  let heardList = [];
  async function loadToRate() {
    // 1. Écoutés sans note (données du site)
    try {
      const albums = await loadAlbums();
      const list = albums.filter((a) => a.listened && !a.rating).sort((a, b) => (b.listenedOn || "").localeCompare(a.listenedOn || ""));
      $("#to-rate").innerHTML = list.length ? list.map((a) => rowHTML({
        key: a.id, cover: a.cover, album: a.album, artist: a.artist,
        when: a.listenedOn ? "Écouté le " + fmt(a.listenedOn) : "",
        actions: `<button class="btn" type="button" data-act="rate">Noter</button>`,
      })).join("") : `<p class="hint">Tous tes albums écoutés ont une note 👍</p>`;
    } catch { $("#to-rate").innerHTML = `<p class="hint">Liste indisponible.</p>`; }
    // 2. Écoutés en entier sur Spotify, hors base
    try {
      heardList = (await api("/heard")).heard || [];
      $("#heard-title").hidden = !heardList.length;
      $("#heard").innerHTML = heardList.slice().reverse().map((h) => rowHTML({
        key: h.spotifyId, cover: h.thumb || h.cover, album: h.album, artist: h.artist,
        extra: h.released ? " · " + esc(h.released.slice(0, 4)) : "",
        when: "Écouté en entier le " + fmt(h.listenedOn),
        actions: `<button class="btn" type="button" data-act="add">Ajouter</button><button class="btn ghost" type="button" data-act="ignore" title="Ne plus proposer cet album">Ignorer</button>`,
      })).join("");
    } catch { /* section facultative */ }
  }

  $("#rate-panel").addEventListener("click", async (e) => {
    const item = e.target.closest(".todo-item"); if (!item) return;
    const star = e.target.closest(".rate button");
    if (star) {
      const v = +star.dataset.v === +item.dataset.rating ? 0 : +star.dataset.v;
      item.dataset.rating = v; paintStars(item.querySelector(".rate"), v);
      return;
    }
    const btn = e.target.closest(".btn"); if (!btn) return;
    const r = +item.dataset.rating || null;
    const act = btn.dataset.act;
    if (act === "rate" && !r) return toast("Choisis d'abord une note", true);
    btn.disabled = true;
    try {
      let res;
      if (act === "rate") {
        res = await api(`/albums/${item.dataset.key}`, { method: "PATCH", body: JSON.stringify({ rating: r }) });
      } else if (act === "add") {
        const h = heardList.find((x) => x.spotifyId === item.dataset.key);
        let genres = [];
        try { genres = (await api(`/search?album=${encodeURIComponent(h.album)}&artist=${encodeURIComponent(h.artist)}`)).results.find((x) => x.spotifyId === h.spotifyId)?.genres || []; } catch {}
        res = await api("/albums", { method: "POST", body: JSON.stringify({
          album: h.album, artist: h.artist, released: h.released, link: h.link, cover: h.cover, genres,
          listened: true, rating: r, listenedOn: h.listenedOn, fromHeard: h.spotifyId,
        }) });
      } else if (act === "ignore") {
        await api(`/heard/${item.dataset.key}`, { method: "DELETE" });
      }
      item.remove();
      $("#heard-title").hidden = !document.querySelector("#heard .todo-item");
      if (act !== "ignore") toast(res?.published ? "Enregistré ✓ Le site se met à jour dans une minute." : "Enregistré ✓ Visible sur le site dans l'heure.");
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  });

  // ---------- Migration des liens vers Spotify ----------
  let mResults = [];
  $("#m-start").addEventListener("click", async () => {
    const btn = $("#m-start"); btn.disabled = true;
    $("#m-list").innerHTML = ""; $("#m-apply").hidden = true; mResults = [];
    try {
      const { ids } = await api("/migrate/todo");
      if (!ids.length) { $("#m-progress").textContent = "Tous les albums ont déjà un lien Spotify."; return; }
      for (let i = 0; i < ids.length; i += 10) {
        $("#m-progress").textContent = `Recherche… ${Math.min(i, ids.length)} / ${ids.length}`;
        const { results } = await api("/migrate/preview", { method: "POST", body: JSON.stringify({ ids: ids.slice(i, i + 10) }) });
        mResults.push(...results);
      }
      $("#m-progress").textContent = `${mResults.length} albums analysés. Vérifie surtout les lignes en rouge.`;
      renderMigration();
    } catch (err) { toast(err.message, true); $("#m-progress").textContent = ""; }
    finally { btn.disabled = false; }
  });

  function renderMigration() {
    const order = { aucun: 0, douteux: 1, probable: 2, "sûr": 3 };
    const label = { aucun: "Aucun résultat", douteux: "Douteux", probable: "Probable", "sûr": "Sûr" };
    const sorted = [...mResults].sort((a, b) => order[a.confidence] - order[b.confidence]);
    let last = "";
    $("#m-list").innerHTML = sorted.map((r) => {
      const head = r.confidence !== last ? `<p class="mgroup">${label[r.confidence]}</p>` : "";
      last = r.confidence;
      const checked = r.confidence === "sûr" || r.confidence === "probable";
      return head + `<label class="mrow">
        <input type="checkbox" data-id="${r.id}" ${r.spotify ? "" : "disabled"} ${checked && r.spotify ? "checked" : ""}>
        <img src="${esc(r.spotify?.thumb || "")}" alt="" onerror="this.style.visibility='hidden'">
        <div><b>${esc(r.album)} — ${esc(r.artist)}</b>
          <span>${r.spotify ? `Spotify : ${esc(r.spotify.album)} — ${esc(r.spotify.artist)} (${esc((r.spotify.released || "").slice(0, 4))}, ${r.spotify.tracks} titres)` : "Rien trouvé sur Spotify"}</span></div>
        <span class="tag ${r.confidence === "sûr" ? "sur" : r.confidence}">${label[r.confidence]}</span>
      </label>`;
    }).join("");
    updateApply();
  }
  const checkedItems = () => [...document.querySelectorAll("#m-list input:checked")].map((c) => {
    const r = mResults.find((x) => x.id === c.dataset.id);
    return { id: r.id, link: r.spotify.link };
  });
  function updateApply() {
    const n = checkedItems().length;
    $("#m-apply").hidden = !mResults.length;
    $("#m-apply").textContent = `Remplacer ${n} lien${n > 1 ? "s" : ""} dans Notion`;
    $("#m-apply").disabled = !n;
  }
  $("#m-list").addEventListener("change", updateApply);
  $("#m-apply").addEventListener("click", async () => {
    const items = checkedItems(); const btn = $("#m-apply"); btn.disabled = true;
    try {
      let done = 0;
      for (let i = 0; i < items.length; i += 30) {
        const r = await api("/migrate/apply", { method: "POST", body: JSON.stringify({ items: items.slice(i, i + 30) }) });
        done += r.updated;
        $("#m-progress").textContent = `Mise à jour… ${done} / ${items.length}`;
      }
      const ids = new Set(items.map((x) => x.id));
      mResults = mResults.filter((r) => !ids.has(r.id));
      renderMigration();
      $("#m-progress").textContent = `${done} liens remplacés dans Notion ✓${mResults.length ? " Les albums restants n'ont pas été modifiés." : ""}`;
      toast(`${done} liens remplacés ✓`);
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  });

  start();
})();
