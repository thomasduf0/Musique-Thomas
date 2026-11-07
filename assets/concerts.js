// Page Concerts : liste des concerts et festivals, fiche détaillée (setlist, modifications), carte des salles,
// statistiques et artistes à compléter.
// Données : data/concerts.json (synchro horaire), puis les bases Notion en direct via la fonction Cloudflare.
(() => {
  const $ = (s) => document.querySelector(s);
  const API = (window.MUSIQUE_API || "").replace(/\/$/, "");
  const state = {
    view: "list", events: [], acts: [], venues: {}, setlists: {}, byEvent: new Map(), byId: new Map(), loose: [],
    map: null, layer: null, markers: [], current: null,
  };
  const els = {
    list: $("#list"), mapView: $("#map-view"), stats: $("#stats"), todo: $("#todo"), filters: $("#filters"), count: $("#count"),
    year: $("#f-year"), type: $("#f-type"), city: $("#f-city"), sort: $("#f-sort"), q: $("#q"),
    wish: $("#wish"), dialog: $("#detail"), body: $("#detail-body"),
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const fmt = (d, o = { day: "numeric", month: "long", year: "numeric" }) => (d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", o) : "");
  const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
  const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
  // Nom affiché : « Hoshi — Toulouse » → « Hoshi » (la ville est déjà indiquée à côté)
  const title = (e) => (e.type === "Festival" ? e.name : e.name.replace(/\s+—\s+.*$/, ""));
  const place = (e) => [e.venue, e.city].filter(Boolean).join(" · ");
  // Wantlist : concerts qui me tentent, sans billet pour l'instant (statut « Envie » dans Notion)
  const wish = (e) => !!e && e.status === "Envie";
  const upcoming = (e) => !!e && !wish(e) && (e.status === "À venir" || (!!e.start && e.start > today()));
  const real = () => state.events.filter((e) => !wish(e));
  const evYear = (e) => (e.start || "").slice(0, 4);
  const eventOf = (a) => state.byId.get(a.event);

  function toast(msg, err = false) {
    const t = $("#toast");
    (els.dialog.open ? els.dialog : document.body).appendChild(t);
    t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = "toast"), 4000);
  }

  // ---------- Mot de passe (le même que sur le reste du site) ----------
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  let password = store.get("musique:pw");
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", "X-Password": password, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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
  function unlock() { $("#gate").hidden = true; document.body.classList.remove("locked"); load(); }
  async function checkAccess() {
    if (!API || !password) return showGate();
    try {
      await api("/status");
      store.set("musique:ok", "1");
      unlock();
    } catch (e) {
      if (e.auth) { password = ""; store.set("musique:pw", ""); store.set("musique:ok", ""); return showGate("Mot de passe incorrect."); }
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

  // ---------- Données ----------
  const getJSON = (u) => fetch(`${u}?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  async function load() {
    const [data, venues, setlists] = await Promise.all([getJSON("data/concerts.json"), getJSON("data/venues.json"), getJSON("data/setlists.json")]);
    state.venues = venues || {};
    state.setlists = setlists || {};
    if (!data) { els.list.innerHTML = `<p class="empty">Impossible de charger les concerts pour le moment.</p>`; return; }
    setData(data);
    const hash = location.hash.slice(1);
    setView(["list", "map", "stats", "todo", "wish"].includes(hash) ? hash : "list");
    // Puis les bases Notion en direct (modifications faites depuis la dernière synchro)
    try {
      const live = await fetch(`${API}/export/concerts`).then((r) => (r.ok ? r.json() : null));
      if (live?.events) { setData({ ...live, updatedAt: new Date().toISOString() }); refresh(); }
    } catch {}
  }

  function setData(data) {
    state.events = data.events.map((e) => ({ ...e }));
    state.acts = data.acts.map((a) => ({ ...a }));
    if (data.updatedAt) $("#updated").textContent = "mis à jour le " + new Date(data.updatedAt).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
    index();
  }

  // Recalcule les liens concerts ↔ artistes et les positions sur la carte
  function index() {
    state.byId = new Map(state.events.map((e) => [e.id, e]));
    state.byEvent = new Map(state.events.map((e) => [e.id, []]));
    state.loose = [];
    for (const a of state.acts) {
      if (a.event && !state.byId.has(a.event)) a.event = null;
      (a.event ? state.byEvent.get(a.event) : state.loose).push(a);
    }
    // Tête d'affiche (l'artiste du titre) en premier, puis par jour et par nom
    for (const [id, list] of state.byEvent) {
      const head = norm(title(state.byId.get(id)));
      list.sort((a, b) => (norm(b.artist) === head) - (norm(a.artist) === head) || (a.date || "9").localeCompare(b.date || "9") || a.artist.localeCompare(b.artist, "fr"));
    }
    state.loose.sort((a, b) => a.artist.localeCompare(b.artist, "fr"));
    for (const e of state.events) {
      const pos = state.venues[`${e.venue || ""}|${e.city || ""}`] || state.venues[`|${e.city || ""}`];
      if (pos) [e.lat, e.lng] = pos;
      else if (e.lat == null) e.lat = e.lng = null;
    }
    fillFilters();
    renderKpis();
    const n = todoActs().length + real().filter((e) => !e.start).length;
    $("#todo-n").textContent = n || "";
    $("#wish-n").textContent = state.events.filter(wish).length || "";
  }

  function refresh() {
    ({ list: renderList, map: renderMap, stats: renderStats, todo: renderTodo, wish: renderWish })[state.view]?.();
    if (els.dialog.open && state.current) openEvent(state.current, true);
  }

  const seenEvents = () => real().filter((e) => !upcoming(e));
  // Passages vus : tous ceux d'un événement passé, plus ceux pas encore rattachés à un événement
  const seenActs = () => state.acts.filter((a) => (a.event ? !upcoming(eventOf(a)) && !wish(eventOf(a)) : !(a.date && a.date > today())));
  const todoActs = () => state.loose;

  function fillFilters() {
    const keep = [els.year.value, els.city.value];
    const years = [...new Set(real().map(evYear).filter(Boolean))].sort().reverse();
    els.year.innerHTML = `<option value="">Toutes les années</option>` + years.map((y) => `<option>${y}</option>`).join("");
    const cities = [...new Set(real().map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    els.city.innerHTML = `<option value="">Toutes les villes</option>` + cities.map((c) => `<option>${esc(c)}</option>`).join("");
    [els.year.value, els.city.value] = keep;
    // Suggestions pour les formulaires
    const venues = [...new Set(state.events.map((e) => e.venue).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    $("#dl-venues").innerHTML = venues.map((v) => `<option value="${esc(v)}">`).join("");
    $("#dl-cities").innerHTML = cities.map((c) => `<option value="${esc(c)}">`).join("");
    const artists = [...new Set(state.acts.map((a) => a.artist))].sort((a, b) => a.localeCompare(b, "fr"));
    $("#dl-artists").innerHTML = artists.map((a) => `<option value="${esc(a)}">`).join("");
  }
  // Ville la plus utilisée pour une salle déjà connue
  const cityOfVenue = (v) => state.events.find((e) => e.venue && norm(e.venue) === norm(v))?.city || "";

  function renderKpis() {
    const ev = seenEvents(), acts = seenActs();
    const k = [
      ["Artistes vus en live", acts.length],
      ["Concerts", ev.filter((e) => e.type !== "Festival").length],
      ["Festivals", ev.filter((e) => e.type === "Festival").length],
      ["Villes", new Set(ev.map((e) => e.city).filter(Boolean)).size],
      ["À venir", state.events.filter(upcoming).length],
    ];
    $("#kpis").innerHTML = k.map(([t, v]) => `<div><dt>${t}</dt><dd>${v}</dd></div>`).join("");
  }

  // ---------- Liste ----------
  function matches(e, q) {
    if (!q) return true;
    const hay = norm([e.name, e.venue, e.city, ...state.byEvent.get(e.id).map((a) => a.artist)].join(" "));
    return q.split(/\s+/).every((w) => hay.includes(w));
  }
  function filtered() {
    const q = norm(els.q.value), y = els.year.value, t = els.type.value, c = els.city.value;
    return real().filter((e) => (!y || evYear(e) === y) && (!t || e.type === t) && (!c || e.city === c) && matches(e, q));
  }
  // Concert (pas festival) : les artistes autres que celui du titre sont des 1res parties
  const isOpener = (a, e) => e.type !== "Festival" && norm(a.artist) !== norm(title(e)) && (state.byEvent.get(e.id) || []).some((x) => norm(x.artist) === norm(title(e)));
  const hasSongs = (a) => !!state.setlists[a.setlist]?.sets?.length;
  const chipHit = (a, q) => q && q.split(/\s+/).every((w) => norm(a.artist).includes(w));
  const artistChip = (a, q) =>
    `<span class="a-chip${chipHit(a, q) ? " hit" : ""}">${esc(a.artist)}${a.setlist ? `<span class="sl" aria-label="setlist disponible">♫</span>` : ""}</span>`;

  function dateBlock(e) {
    if (!e.start) return `<div class="c-date unknown"><b>?</b><span>date à préciser</span></div>`;
    const d = new Date(e.start + "T12:00:00");
    const end = e.end && e.end !== e.start ? new Date(e.end + "T12:00:00") : null;
    const day = end ? `${d.getDate()}–${end.getDate()}` : d.getDate();
    return `<div class="c-date"><b>${day}</b><span>${d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "")} ${d.getFullYear()}</span></div>`;
  }
  function tags(e) {
    return [
      e.type === "Festival" ? `<span class="tag fest">Festival</span>` : "",
      e.status === "À vérifier" ? `<span class="tag warn">À vérifier</span>` : "",
      upcoming(e) ? `<span class="tag soon">À venir</span>` : "",
      wish(e) ? `<span class="tag wish">Wantlist</span>` : "",
    ].join("");
  }

  function eventCard(e, q) {
    const acts = state.byEvent.get(e.id) || [];
    const fest = e.type === "Festival";
    // Artistes affichés quand ils ne sont pas déjà dans le titre
    const showActs = fest || acts.length > 1 || (acts[0] && norm(acts[0].artist) !== norm(title(e)));
    const openers = acts.filter((a) => isOpener(a, e));
    const lineup = !fest && openers.length && openers.length === acts.length - 1
      ? `<p class="c-place c-open">1re partie : ${openers.map((a) => esc(a.artist)).join(", ")}</p>`
      : showActs && acts.length ? `<div class="chips">${acts.map((a) => artistChip(a, q)).join("")}</div>` : "";
    const songs = acts.filter(hasSongs).length;
    return `<button type="button" class="c-card${fest ? " is-fest" : ""}${upcoming(e) ? " is-soon" : ""}" data-id="${e.id}">
      ${dateBlock(e)}
      <div class="c-body">
        <div class="c-head"><h3>${esc(title(e))}</h3>${tags(e)}</div>
        <p class="c-place">${esc(place(e)) || "Lieu à préciser"}${fest && acts.length ? ` · ${plural(acts.length, "artiste")}` : ""}${songs ? ` · <span class="c-sl">♫ setlist</span>` : ""}</p>
        ${lineup}
      </div>
    </button>`;
  }

  function renderList() {
    const q = norm(els.q.value);
    const list = filtered();
    const asc = els.sort.value === "asc";
    const soon = list.filter(upcoming).sort((a, b) => (a.start || "9").localeCompare(b.start || "9"));
    const past = list.filter((e) => !upcoming(e));
    const dated = past.filter((e) => e.start).sort((a, b) => (asc ? 1 : -1) * a.start.localeCompare(b.start));
    const undated = past.filter((e) => !e.start);

    const groups = new Map();
    dated.forEach((e) => { const y = evYear(e); groups.has(y) || groups.set(y, []); groups.get(y).push(e); });

    let html = "";
    if (soon.length) html += `<h2 class="c-year soon-h">À venir <small>${plural(soon.length, "date")}</small></h2><div class="c-grid">${soon.map((e) => eventCard(e, q)).join("")}</div>`;
    for (const [y, evs] of groups) {
      const n = evs.reduce((s, e) => s + Math.max(1, state.byEvent.get(e.id).length), 0);
      html += `<h2 class="c-year">${y} <small>${plural(evs.length, "sortie")} · ${plural(n, "artiste")}</small></h2><div class="c-grid">${evs.map((e) => eventCard(e, q)).join("")}</div>`;
    }
    if (undated.length) html += `<h2 class="c-year">Date à préciser <small>${plural(undated.length, "concert")}</small></h2><div class="c-grid">${undated.map((e) => eventCard(e, q)).join("")}</div>`;

    // Artistes encore sans concert (renvoi vers l'onglet dédié)
    const loose = q ? state.loose.filter((a) => chipHit(a, q)) : [];
    if (loose.length) {
      html += `<h2 class="c-year">Sans date ni lieu <small>${plural(loose.length, "passage")}</small></h2>
        <p class="c-hint">À compléter dans l'onglet <button type="button" class="linkish" data-goto="todo">Artistes non complétés</button>.</p>`;
    }
    els.count.textContent = plural(list.length, "concert ou festival", "concerts et festivals") + (q || els.year.value || els.type.value || els.city.value ? " correspondent" : "");
    els.list.innerHTML = html || `<p class="empty">Aucun concert ne correspond.</p>`;
  }

  els.list.addEventListener("click", (ev) => {
    const go = ev.target.closest("[data-goto]");
    if (go) return setView(go.dataset.goto);
    const card = ev.target.closest(".c-card");
    if (card) openEvent(card.dataset.id);
  });

  // ---------- Fiche d'un concert (comme la fiche d'un album) ----------
  function setlistHTML(a) {
    const sl = state.setlists[a.setlist];
    if (!sl?.sets?.length) return a.setlist ? `<a class="c-link" href="${esc(a.setlist)}" target="_blank" rel="noopener">Voir la setlist sur setlist.fm ↗</a>` : "";
    let n = 0;
    return `<div class="setlist">
      ${sl.tour ? `<p class="sl-tour">${esc(sl.tour)}</p>` : ""}
      ${sl.sets.map((set) => `${set.name ? `<p class="sl-set">${esc(set.name)}</p>` : ""}
        <ol start="${n + 1}">${set.songs.map((s) => { n++; return `<li>${esc(s.name)}${s.cover ? ` <small>(reprise de ${esc(s.cover)})</small>` : ""}${s.with ? ` <small>avec ${esc(s.with)}</small>` : ""}${s.tape ? ` <small>(bande)</small>` : ""}</li>`; }).join("")}</ol>`).join("")}
      <a class="c-link" href="${esc(a.setlist)}" target="_blank" rel="noopener">setlist.fm ↗</a>
    </div>`;
  }

  function actRow(a, e) {
    const fest = e.type === "Festival";
    return `<div class="d-act" data-act="${a.id}">
      <div class="d-act-h">
        <b>${esc(a.artist)}</b>
        ${fest && a.date ? `<span class="muted">${esc(fmt(a.date, { weekday: "long", day: "numeric", month: "long" }))}</span>` : ""}
        ${!fest && isOpener(a, e) ? `<span class="muted">1re partie</span>` : ""}
        <button type="button" class="mini" data-edit-act="${a.id}">Modifier</button>
      </div>
      ${setlistHTML(a)}
      <form class="edit act-edit" data-form-act="${a.id}" hidden>
        <label>Artiste<input name="artist" list="dl-artists" value="${esc(a.artist)}" required></label>
        ${fest ? `<label>Jour<input name="date" type="date" value="${esc(a.date || "")}" min="${esc(e.start || "")}" max="${esc(e.end || e.start || "")}"></label>` : ""}
        <label>Lien de la setlist (setlist.fm)<input name="setlist" type="url" value="${esc(a.setlist || "")}" placeholder="https://www.setlist.fm/setlist/…"></label>
        <div class="btns">
          <button class="btn">Enregistrer</button>
          <button type="button" class="btn ghost" data-cancel>Annuler</button>
          <button type="button" class="btn ghost danger" data-detach="${a.id}">Retirer de ce concert</button>
        </div>
      </form>
    </div>`;
  }

  function openEvent(id, keep = false) {
    const e = state.byId.get(id);
    if (!e) return;
    state.current = id;
    const acts = state.byEvent.get(id) || [];
    const fest = e.type === "Festival";
    els.body.innerHTML = `<div class="c-d">
      <header class="c-d-head">
        ${dateBlock(e)}
        <div>
          <div class="c-head"><h2>${esc(title(e))}</h2>${tags(e)}</div>
          <p class="c-place">${esc(place(e)) || "Lieu à préciser"}${e.start ? " · " + esc(fmt(e.start, { weekday: "long", day: "numeric", month: "long", year: "numeric" })) + (e.end && e.end !== e.start ? " → " + esc(fmt(e.end, { day: "numeric", month: "long" })) : "") : ""}</p>
        </div>
      </header>
      <button type="button" class="btn edit-btn" id="edit-event">Modifier le concert</button>
      <form class="edit" id="event-form" hidden>
        <p class="edit-title">Concert</p>
        <label>Nom<input name="name" value="${esc(e.name)}" required></label>
        <div class="row2">
          <label>Type<select name="type"><option${!fest ? " selected" : ""}>Concert</option><option${fest ? " selected" : ""}>Festival</option></select></label>
          <label>Statut<select name="status">${[["Vu", "Vu"], ["À venir", "À venir (billet pris)"], ["À vérifier", "À vérifier"], ["Envie", "Wantlist (pas de billet)"]].map(([v, l]) => `<option value="${v}"${e.status === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        </div>
        <div class="row2">
          <label>Date<input name="start" type="date" value="${esc(e.start || "")}"></label>
          <label>Fin (festival sur plusieurs jours)<input name="end" type="date" value="${esc(e.end || "")}"></label>
        </div>
        <div class="row2">
          <label>Salle ou lieu<input name="venue" list="dl-venues" value="${esc(e.venue || "")}"></label>
          <label>Ville<input name="city" list="dl-cities" value="${esc(e.city || "")}"></label>
        </div>
        <div class="btns"><button class="btn">Enregistrer</button> <button type="button" class="btn ghost" data-cancel>Annuler</button></div>
      </form>
      <h3 class="d-sub">${fest ? "Artistes vus" : acts.length > 1 ? "À l'affiche" : "Artiste"} <small>${acts.length || ""}</small></h3>
      <div class="d-acts">${acts.map((a) => actRow(a, e)).join("") || `<p class="muted">Aucun artiste rattaché.</p>`}</div>
      <form class="edit add-act" id="add-act">
        <p class="edit-title">Ajouter un artiste à ce concert</p>
        <div class="row2">
          <label>Artiste<input name="artist" list="dl-artists" required placeholder="Nom de l'artiste"></label>
          ${fest ? `<label>Jour<input name="date" type="date" min="${esc(e.start || "")}" max="${esc(e.end || e.start || "")}" value="${esc(e.end ? "" : e.start || "")}"></label>` : ""}
        </div>
        <p class="hint">S'il est dans « Artistes non complétés », il y est rattaché au lieu d'être créé une 2e fois.</p>
        <div class="btns"><button class="btn">Ajouter</button></div>
      </form>
    </div>`;
    if (!keep) els.dialog.showModal();
  }

  const formData = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v).trim()]));
  async function busy(btn, fn) {
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Enregistrement…"; }
    try { await fn(); }
    catch (err) {
      if (err.auth) { toast("Mot de passe refusé : reconnecte-toi.", true); return showGate("Mot de passe incorrect."); }
      toast(err.message || "Enregistrement impossible", true);
    } finally { if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; } }
  }
  const saved = (msg) => { index(); refresh(); toast(msg + " Enregistré dans Notion."); };

  els.body.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.id === "edit-event") { $("#event-form").hidden = false; t.hidden = true; $("#event-form input").focus(); return; }
    if (t.matches("[data-cancel]")) { const f = t.closest("form"); f.hidden = true; if (f.id === "event-form") $("#edit-event").hidden = false; return; }
    if (t.dataset.editAct) { const f = els.body.querySelector(`[data-form-act="${t.dataset.editAct}"]`); f.hidden = !f.hidden; return; }
    if (t.dataset.detach) {
      const a = state.acts.find((x) => x.id === t.dataset.detach);
      return busy(t, async () => {
        await api(`/concerts/acts/${a.id}`, { method: "PATCH", body: { event: null, date: null } });
        a.event = null; a.date = null;
        saved(`${a.artist} est passé dans « Artistes non complétés ».`);
      });
    }
  });

  els.body.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const form = ev.target, btn = form.querySelector("button:not([type=button])"), e = state.byId.get(state.current);
    if (form.id === "event-form") {
      const d = formData(form);
      if (d.end && d.start && d.end < d.start) return toast("La date de fin est avant la date de début.", true);
      const body = { name: d.name, type: d.type, status: d.status, start: d.start || null, end: d.end || null, venue: d.venue || null, city: d.city || null };
      return busy(btn, async () => {
        await api(`/concerts/events/${e.id}`, { method: "PATCH", body });
        Object.assign(e, body);
        saved("Concert modifié.");
      });
    }
    if (form.dataset.formAct) {
      const a = state.acts.find((x) => x.id === form.dataset.formAct), d = formData(form);
      const body = { artist: d.artist, setlist: d.setlist || null, ...("date" in d ? { date: d.date || null } : {}) };
      return busy(btn, async () => {
        await api(`/concerts/acts/${a.id}`, { method: "PATCH", body });
        Object.assign(a, body);
        saved(`${a.artist} modifié.`);
      });
    }
    if (form.id === "add-act") {
      const d = formData(form);
      const date = d.date || (e.type === "Festival" ? null : e.start) || null;
      // Réutilise un passage « non complété » du même artiste plutôt que d'en créer un nouveau
      const existing = state.loose.find((a) => norm(a.artist) === norm(d.artist));
      return busy(btn, async () => {
        if (existing) {
          await api(`/concerts/acts/${existing.id}`, { method: "PATCH", body: { event: e.id, date } });
          Object.assign(existing, { event: e.id, date });
        } else {
          const r = await api("/concerts/acts", { method: "POST", body: { artist: d.artist, event: e.id, date } });
          state.acts.push({ id: r.id, artist: d.artist, event: e.id, date, setlist: null, rating: null });
        }
        saved(`${d.artist} ajouté.`);
      });
    }
  });

  // ---------- Artistes non complétés ----------
  function eventOptions() {
    const evs = real().filter((e) => e.start).sort((a, b) => b.start.localeCompare(a.start));
    return `<option value="">— Nouveau concert —</option>` + evs.map((e) =>
      `<option value="${e.id}">${esc(fmt(e.start, { day: "numeric", month: "short", year: "numeric" }))} · ${esc(title(e))}${e.city ? " (" + esc(e.city) + ")" : ""}</option>`).join("");
  }
  function renderTodo() {
    const undated = real().filter((e) => !e.start);
    const acts = todoActs();
    const opts = eventOptions();
    els.todo.innerHTML = `
      <p class="c-hint">Pour chaque artiste : choisis un concert déjà enregistré (festival compris), ou indique la date, la salle et la ville pour créer le concert. Tout est enregistré dans Notion.</p>
      ${undated.length ? `<h2 class="c-year">Concerts sans date <small>${undated.length}</small></h2>
        <div class="todo-list">${undated.map((e) => `
          <form class="todo-row" data-ev="${e.id}">
            <div class="todo-who"><b>${esc(title(e))}</b><small>${esc(state.byEvent.get(e.id).map((a) => a.artist).filter((n) => norm(n) !== norm(title(e))).join(", "))}</small></div>
            <label>Date<input name="start" type="date" required></label>
            <label>Salle<input name="venue" list="dl-venues" value="${esc(e.venue || "")}" placeholder="Salle ou lieu"></label>
            <label>Ville<input name="city" list="dl-cities" value="${esc(e.city || "")}" required></label>
            <button class="btn">Enregistrer</button>
          </form>`).join("")}</div>` : ""}
      <h2 class="c-year">Artistes sans concert <small>${acts.length}</small></h2>
      ${acts.length ? `<div class="todo-list">${acts.map((a) => `
        <form class="todo-row" data-act="${a.id}">
          <div class="todo-who"><b>${esc(a.artist)}</b>${a.date ? `<small>vu le ${esc(fmt(a.date))}</small>` : ""}</div>
          <label class="todo-ev">Concert<select name="event">${opts}</select></label>
          <label>Date<input name="date" type="date" value="${esc(a.date || "")}"></label>
          <label class="for-new">Salle<input name="venue" list="dl-venues" placeholder="Salle ou lieu"></label>
          <label class="for-new">Ville<input name="city" list="dl-cities" placeholder="Ville"></label>
          <button class="btn">Enregistrer</button>
        </form>`).join("")}</div>` : `<p class="empty">Tous les artistes sont rattachés à un concert. 🎉</p>`}`;
  }

  els.todo.addEventListener("change", (ev) => {
    const row = ev.target.closest(".todo-row");
    if (!row) return;
    if (ev.target.name === "event") row.classList.toggle("has-event", !!ev.target.value);
    // Salle connue : on remplit la ville
    if (ev.target.name === "venue" && ev.target.value) {
      const city = row.querySelector("[name=city]");
      if (city && !city.value) city.value = cityOfVenue(ev.target.value);
    }
  });

  els.todo.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const form = ev.target, btn = form.querySelector("button"), d = formData(form);
    if (form.dataset.ev) {
      const e = state.byId.get(form.dataset.ev);
      const body = { start: d.start, end: null, venue: d.venue || null, city: d.city, status: d.start > today() ? "À venir" : "Vu" };
      return busy(btn, async () => {
        await api(`/concerts/events/${e.id}`, { method: "PATCH", body });
        Object.assign(e, body);
        saved(`${title(e)} : date enregistrée.`);
      });
    }
    const a = state.acts.find((x) => x.id === form.dataset.act);
    if (d.event) {
      const e = state.byId.get(d.event);
      const date = d.date || (e.type === "Festival" ? null : e.start);
      return busy(btn, async () => {
        await api(`/concerts/acts/${a.id}`, { method: "PATCH", body: { event: e.id, date } });
        Object.assign(a, { event: e.id, date });
        saved(`${a.artist} rattaché à ${title(e)}.`);
      });
    }
    if (!d.date || !d.city) return toast("Choisis un concert, ou indique au moins la date et la ville.", true);
    // Même date et même lieu qu'un concert existant : on s'y rattache
    const same = state.events.find((e) => e.start === d.date && norm(e.city) === norm(d.city) && (!d.venue || !e.venue || norm(e.venue) === norm(d.venue)));
    return busy(btn, async () => {
      let id = same?.id;
      if (!id) {
        const ev2 = { name: `${a.artist} — ${d.city}`, type: "Concert", status: d.date > today() ? "À venir" : "Vu", start: d.date, end: null, venue: d.venue || null, city: d.city };
        id = (await api("/concerts/events", { method: "POST", body: ev2 })).id;
        state.events.push({ id, ...ev2, lat: null, lng: null });
      }
      await api(`/concerts/acts/${a.id}`, { method: "PATCH", body: { event: id, date: d.date } });
      Object.assign(a, { event: id, date: d.date });
      saved(`${a.artist} : concert du ${fmt(d.date)} enregistré.`);
    });
  });

  // ---------- Wantlist ----------
  const daysTo = (d) => Math.round((new Date(d + "T12:00:00") - new Date(today() + "T12:00:00")) / 864e5);
  function when(e) {
    if (!e.start) return "date à préciser";
    const n = daysTo(e.start);
    return n > 1 ? `dans ${n} jours` : n === 1 ? "demain" : n === 0 ? "aujourd'hui" : "date passée";
  }
  function wishCard(e) {
    const acts = state.byEvent.get(e.id) || [];
    const who = acts.map((a) => a.artist).join(", ") || title(e);
    const past = e.start && e.start < today();
    return `<div class="w-card${past ? " is-past" : ""}" data-id="${e.id}">
      ${dateBlock(e)}
      <div class="c-body">
        <h3>${esc(who)}</h3>
        <p class="c-place">${esc(place(e)) || "Lieu à préciser"}</p>
        <p class="w-when">${when(e)}</p>
        <div class="w-actions">
          <button type="button" class="btn" data-w="took">${past ? "J'y suis allé" : "J'ai pris ma place"}</button>
          <button type="button" class="btn ghost" data-w="edit">Modifier</button>
          <button type="button" class="btn ghost danger" data-w="remove">Retirer</button>
        </div>
      </div>
    </div>`;
  }
  function renderWish() {
    const list = state.events.filter(wish).sort((a, b) => (a.start || "9").localeCompare(b.start || "9"));
    els.wish.innerHTML = `
      <p class="c-hint">Les concerts qui te tentent mais pour lesquels tu n'as pas encore de billet. Ils ne comptent pas dans tes statistiques ; « J'ai pris ma place » les passe dans les concerts à venir.</p>
      <form class="todo-row w-add" id="wish-form">
        <label>Artiste<input name="artist" list="dl-artists" required placeholder="Nom de l'artiste"></label>
        <label>Date<input name="start" type="date"></label>
        <label>Salle<input name="venue" list="dl-venues" placeholder="Salle ou lieu"></label>
        <label>Ville<input name="city" list="dl-cities" required placeholder="Ville"></label>
        <button class="btn">Ajouter à la wantlist</button>
      </form>
      ${list.length ? `<div class="c-grid w-grid">${list.map(wishCard).join("")}</div>` : `<p class="empty">Ta wantlist est vide.</p>`}`;
  }
  els.wish.addEventListener("change", (ev) => {
    if (ev.target.name === "venue" && ev.target.value) {
      const city = ev.target.form.querySelector("[name=city]");
      if (!city.value) city.value = cityOfVenue(ev.target.value);
    }
  });
  els.wish.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const form = ev.target, btn = form.querySelector("button"), d = formData(form);
    busy(btn, async () => {
      const e = { name: `${d.artist} — ${d.city}`, type: "Concert", status: "Envie", start: d.start || null, end: null, venue: d.venue || null, city: d.city };
      const id = (await api("/concerts/events", { method: "POST", body: e })).id;
      state.events.push({ id, ...e, lat: null, lng: null });
      const actId = (await api("/concerts/acts", { method: "POST", body: { artist: d.artist, event: id, date: e.start } })).id;
      state.acts.push({ id: actId, artist: d.artist, event: id, date: e.start, setlist: null, rating: null });
      saved(`${d.artist} ajouté à la wantlist.`);
    });
  });
  els.wish.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-w]");
    if (!b) return;
    const e = state.byId.get(b.closest(".w-card").dataset.id);
    if (b.dataset.w === "edit") return openEvent(e.id);
    if (b.dataset.w === "took") {
      const status = e.start && e.start <= today() ? "Vu" : "À venir";
      return busy(b, async () => {
        await api(`/concerts/events/${e.id}`, { method: "PATCH", body: { status } });
        e.status = status;
        saved(status === "Vu" ? `${title(e)} est passé dans tes concerts.` : `Bon concert ! ${title(e)} est passé dans les concerts à venir.`);
      });
    }
    if (b.dataset.w === "remove") {
      // Deux clics pour éviter un retrait par erreur
      if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Confirmer le retrait"; return; }
      return busy(b, async () => {
        await api(`/concerts/events/${e.id}`, { method: "DELETE" });
        state.events = state.events.filter((x) => x.id !== e.id);
        state.acts = state.acts.filter((a) => a.event !== e.id);
        saved(`${title(e)} retiré de la wantlist.`);
      });
    }
  });

  // ---------- Carte ----------
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((ok, fail) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.append(css);
      const s = document.createElement("script");
      s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      s.onload = ok; s.onerror = fail;
      document.head.append(s);
    });
  }

  function venueGroups() {
    const groups = new Map();
    for (const e of real()) {
      if (e.lat == null) continue;
      const k = `${e.lat},${e.lng}`;
      if (!groups.has(k)) groups.set(k, { lat: e.lat, lng: e.lng, events: [] });
      groups.get(k).events.push(e);
    }
    for (const g of groups.values()) {
      g.events.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
      const names = [...new Set(g.events.map((e) => e.venue).filter(Boolean))];
      g.city = g.events[0].city;
      // Plusieurs lieux au même endroit (ex. places du centre d'Agen) : on affiche la ville
      g.name = names.length === 1 ? names[0] : names.length ? `${g.city} (centre-ville)` : g.city;
      g.sub = names.length ? g.city : "Salle à préciser";
      g.seen = g.events.filter((e) => !upcoming(e));
    }
    return [...groups.values()].sort((a, b) => b.seen.length - a.seen.length);
  }

  function popupHTML(g) {
    const rows = g.events.map((e) => {
      const acts = state.byEvent.get(e.id);
      const who = e.type === "Festival" ? `${esc(e.name)} <small>(${plural(acts.length, "artiste")})</small>` : esc(acts.map((a) => a.artist).join(", ") || title(e));
      return `<li><button type="button" class="pop-ev" data-id="${e.id}"><span>${e.start ? fmt(e.start, { day: "numeric", month: "short", year: "numeric" }) : "date ?"}</span>${who}${upcoming(e) ? ` <em>à venir</em>` : ""}</button></li>`;
    }).join("");
    return `<div class="pop"><b>${esc(g.name)}</b><small>${esc(g.sub || "")} · ${plural(g.seen.length, "sortie")}</small><ul>${rows}</ul></div>`;
  }

  async function renderMap() {
    const groups = venueGroups();
    $("#venues").innerHTML = `<h3>Salles et lieux <small>${groups.length}</small></h3>` + groups.map((g, i) => `
      <button type="button" class="v-row" data-i="${i}"><span class="v-n">${esc(g.name)}<small>${esc(g.sub || "")}</small></span><b>${g.seen.length || "—"}</b></button>`).join("");
    try { await loadLeaflet(); } catch {
      $("#map").innerHTML = `<p class="empty">La carte n'a pas pu se charger. Vérifie ta connexion.</p>`;
      return;
    }
    $("#map").classList.toggle("dark-tiles", document.documentElement.dataset.theme !== "light");
    if (!state.map) {
      state.map = L.map("map", { scrollWheelZoom: false });
      // Fond de carte OpenStreetMap (gratuit, sans clé). En mode sombre, il est assombri en CSS.
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(state.map);
      state.map.on("click", () => state.map.scrollWheelZoom.enable());
      state.map.on("popupopen", (ev) => {
        ev.popup.getElement()?.querySelectorAll(".pop-ev").forEach((b) => b.addEventListener("click", () => openEvent(b.dataset.id)));
      });
      state.fitted = false;
    }
    state.layer?.remove();
    state.layer = L.layerGroup().addTo(state.map);
    const max = Math.max(...groups.map((g) => g.seen.length), 1);
    state.markers = groups.map((g) => {
      const soonOnly = !g.seen.length;
      return L.circleMarker([g.lat, g.lng], {
        radius: 7 + 13 * Math.sqrt(g.seen.length / max), weight: 2,
        color: soonOnly ? "#a89c8f" : "#ff7a45", fillColor: soonOnly ? "#a89c8f" : "#ff7a45",
        fillOpacity: soonOnly ? 0.25 : 0.6, dashArray: soonOnly ? "3 3" : null,
      }).bindPopup(popupHTML(g), { maxWidth: 300 }).bindTooltip(`${g.name} · ${g.seen.length || "à venir"}`, { direction: "top" }).addTo(state.layer);
    });
    setTimeout(() => {
      state.map.invalidateSize();
      if (!state.fitted && groups.length) {
        state.map.fitBounds(L.latLngBounds(groups.map((g) => [g.lat, g.lng])).pad(0.15), { maxZoom: 11 });
        state.fitted = true;
      }
    }, 50);
  }
  $("#venues").addEventListener("click", (ev) => {
    const row = ev.target.closest(".v-row");
    if (!row || !state.markers.length) return;
    const m = state.markers[+row.dataset.i];
    state.map.flyTo(m.getLatLng(), 14, { duration: 0.8 });
    setTimeout(() => m.openPopup(), 850);
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ---------- Statistiques ----------
  function bars(title, entries, max = Infinity) {
    const rows = entries.slice(0, max);
    if (!rows.length) return "";
    const top = Math.max(...rows.map(([, v]) => v), 1);
    return `<div class="panel"><h3>${title}</h3>${rows.map(([k, v]) => `
      <div class="bar"><span title="${esc(k)}">${esc(k)}</span><div class="track"><div class="fill" style="width:${(v / top) * 100}%"></div></div><b>${v}</b></div>`).join("")}</div>`;
  }
  const countBy = (list, fn) => {
    const m = new Map();
    list.forEach((x) => [].concat(fn(x)).filter(Boolean).forEach((k) => m.set(k, (m.get(k) || 0) + 1)));
    return [...m.entries()];
  };
  const desc = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "fr");

  function renderStats() {
    const ev = seenEvents(), acts = seenActs();
    const dated = ev.filter((e) => e.start).sort((a, b) => a.start.localeCompare(b.start));
    const actYear = (a) => (a.date || eventOf(a)?.start || "").slice(0, 4) || null;
    const years = [...new Set(dated.map(evYear))].sort();
    const perYear = years.map((y) => [y, dated.filter((e) => evYear(e) === y).length]);
    const actsPerYear = years.map((y) => [y, acts.filter((a) => actYear(a) === y).length]);
    const artists = countBy(acts, (a) => a.artist).filter(([, v]) => v > 1).sort(desc);
    const venues = countBy(ev.filter((e) => e.venue), (e) => `${e.venue} (${e.city})`).sort(desc);
    const cities = countBy(ev, (e) => e.city).sort(desc);
    const months = Array.from({ length: 12 }, (_, i) => [
      new Date(2000, i, 15).toLocaleDateString("fr-FR", { month: "long" }),
      dated.filter((e) => +e.start.slice(5, 7) === i + 1).length,
    ]);
    const kinds = [["Concerts", ev.filter((e) => e.type !== "Festival").length], ["Festivals", ev.filter((e) => e.type === "Festival").length]];
    const fests = ev.filter((e) => e.type === "Festival").map((e) => [e.name, state.byEvent.get(e.id).length]).filter(([, v]) => v).sort(desc);
    const withSetlist = acts.filter((a) => a.setlist).length;
    const first = dated[0], last = dated[dated.length - 1];
    const next = state.events.filter(upcoming).filter((e) => e.start).sort((a, b) => a.start.localeCompare(b.start))[0];
    const fact = (label, value, sub = "") => `<div class="fact"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

    els.stats.innerHTML =
      `<div class="panel facts">
        ${fact("Premier concert enregistré", first ? esc(title(first)) : "—", first ? fmt(first.start) + " · " + esc(first.city || "") : "")}
        ${fact("Dernier concert", last ? esc(title(last)) : "—", last ? fmt(last.start) + " · " + esc(last.city || "") : "")}
        ${fact("Prochain", next ? esc(title(next)) : "—", next ? fmt(next.start) + " · " + esc(next.city || "") : "")}
        ${fact("Artistes différents", new Set(acts.map((a) => a.artist)).size, `sur ${plural(acts.length, "passage")}`)}
        ${fact("Setlists retrouvées", withSetlist, "sur setlist.fm")}
        ${fact("Artistes non complétés", state.loose.length, "sans concert rattaché")}
      </div>` +
      bars("Sorties par année", perYear) +
      bars("Artistes vus par année", actsPerYear) +
      bars("Artistes vus plusieurs fois", artists, 15) +
      bars("Salles les plus fréquentées", venues, 12) +
      bars("Villes", cities, 12) +
      bars("Festivals (nombre d'artistes vus)", fests, 12) +
      bars("Mois des concerts", months) +
      bars("Concerts ou festivals", kinds);
  }

  // ---------- Navigation ----------
  function setView(v) {
    state.view = v;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    history.replaceState(null, "", v === "list" ? location.pathname : "#" + v);
    const isList = v === "list";
    els.filters.hidden = !isList; els.count.hidden = !isList; els.list.hidden = !isList;
    els.mapView.hidden = v !== "map"; els.stats.hidden = v !== "stats"; els.todo.hidden = v !== "todo"; els.wish.hidden = v !== "wish";
    refresh();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  [els.year, els.type, els.city, els.sort].forEach((s) => s.addEventListener("change", renderList));
  let t;
  els.q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (state.view === "list") renderList();
      else if (els.q.value.trim()) setView("list"); // une recherche affiche la liste
    }, 120);
  });
  els.dialog.addEventListener("close", () => { state.current = null; });

  checkAccess();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
