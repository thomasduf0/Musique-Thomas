// Page Concerts : liste des concerts et festivals, carte des salles, statistiques.
// Données : data/concerts.json (généré depuis les bases Notion « Événements » et « Passages »).
(() => {
  const $ = (s) => document.querySelector(s);
  const API = (window.MUSIQUE_API || "").replace(/\/$/, "");
  const state = { view: "list", events: [], acts: [], byEvent: new Map(), loose: [], map: null, layer: null, open: new Set() };
  const els = {
    list: $("#list"), mapView: $("#map-view"), stats: $("#stats"), filters: $("#filters"), count: $("#count"),
    year: $("#f-year"), type: $("#f-type"), city: $("#f-city"), sort: $("#f-sort"), q: $("#q"),
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const fmt = (d, o = { day: "numeric", month: "long", year: "numeric" }) => (d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR", o) : "");
  const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
  const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
  // Nom affiché : « Hoshi — Toulouse » → « Hoshi » (la ville est déjà indiquée à côté)
  const title = (e) => (e.type === "Festival" ? e.name : e.name.replace(/\s+—\s+.*$/, ""));
  const place = (e) => [e.venue, e.city].filter(Boolean).join(" · ");
  const upcoming = (e) => e.status === "À venir" || (e.start && e.start > today());

  // ---------- Mot de passe (le même que sur le reste du site) ----------
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  let password = store.get("musique:pw");
  function showGate(msg = "") {
    $("#gate").hidden = false;
    $("#gate-err").textContent = msg;
    setTimeout(() => $("#gate-pw").focus(), 50);
  }
  function unlock() { $("#gate").hidden = true; document.body.classList.remove("locked"); load(); }
  async function checkAccess() {
    if (!API || !password) return showGate();
    try {
      const res = await fetch(API + "/status", { headers: { "X-Password": password } });
      if (res.status === 401) {
        password = ""; store.set("musique:pw", ""); store.set("musique:ok", "");
        return showGate("Mot de passe incorrect.");
      }
      if (!res.ok) throw new Error(res.status);
      store.set("musique:ok", "1");
      unlock();
    } catch {
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
  async function load() {
    let data;
    try {
      const res = await fetch(`data/concerts.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      els.list.innerHTML = `<p class="empty">Impossible de charger les concerts pour le moment.</p>`;
      return;
    }
    state.events = data.events;
    const ids = new Set(data.events.map((e) => e.id));
    state.acts = data.acts.map((a) => ({ ...a, event: ids.has(a.event) ? a.event : null }));
    state.byEvent = new Map(data.events.map((e) => [e.id, []]));
    state.loose = [];
    for (const a of state.acts) (a.event ? state.byEvent.get(a.event) : state.loose).push(a);
    for (const list of state.byEvent.values()) list.sort((a, b) => (a.date || "9").localeCompare(b.date || "9") || a.artist.localeCompare(b.artist, "fr"));
    state.loose.sort((a, b) => a.artist.localeCompare(b.artist, "fr"));
    $("#updated").textContent = data.updatedAt ? "mis à jour le " + new Date(data.updatedAt).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) : "";
    fillFilters();
    renderKpis();
    const hash = location.hash.slice(1);
    setView(["list", "map", "stats"].includes(hash) ? hash : "list");
  }

  const evYear = (e) => (e.start || "").slice(0, 4);
  const seenEvents = () => state.events.filter((e) => !upcoming(e));
  // Passages vus : tous ceux d'un événement passé, plus ceux pas encore rattachés à un événement
  const seenActs = () => state.acts.filter((a) => (a.event ? !upcoming(eventOf(a)) : !(a.date && a.date > today())));
  const eventOf = (a) => state.events.find((e) => e.id === a.event);

  function fillFilters() {
    const years = [...new Set(state.events.map(evYear).filter(Boolean))].sort().reverse();
    els.year.innerHTML = `<option value="">Toutes les années</option>` + years.map((y) => `<option>${y}</option>`).join("");
    const cities = [...new Set(state.events.map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    els.city.innerHTML = `<option value="">Toutes les villes</option>` + cities.map((c) => `<option>${esc(c)}</option>`).join("");
  }

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
    return state.events.filter((e) => (!y || evYear(e) === y) && (!t || e.type === t) && (!c || e.city === c) && matches(e, q));
  }

  const artistChip = (a, q) => {
    const hit = q && q.split(/\s+/).every((w) => norm(a.artist).includes(w));
    const tip = [a.date && a.date !== "" ? fmt(a.date, { weekday: "long", day: "numeric", month: "long" }) : "", a.comment].filter(Boolean).join(" · ");
    return `<button type="button" class="a-chip${hit ? " hit" : ""}" data-artist="${esc(a.artist)}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(a.artist)}${a.setlist ? `<span class="sl" aria-label="setlist disponible">♫</span>` : ""}</button>`;
  };

  function dateBlock(e) {
    if (!e.start) return `<div class="c-date unknown"><b>?</b><span>date à préciser</span></div>`;
    const d = new Date(e.start + "T12:00:00");
    const end = e.end && e.end !== e.start ? new Date(e.end + "T12:00:00") : null;
    const day = end ? `${d.getDate()}–${end.getDate()}` : d.getDate();
    return `<div class="c-date"><b>${day}</b><span>${d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "")} ${d.getFullYear()}</span></div>`;
  }

  function eventCard(e, q) {
    const acts = state.byEvent.get(e.id) || [];
    const fest = e.type === "Festival";
    const badges = [
      fest ? `<span class="tag fest">Festival</span>` : "",
      e.status === "À vérifier" ? `<span class="tag warn">À vérifier</span>` : "",
      upcoming(e) ? `<span class="tag soon">À venir</span>` : "",
    ].join("");
    // Festival : artistes regroupés par jour
    let lineup = "";
    if (fest && acts.length) {
      const days = new Map();
      acts.forEach((a) => { const k = a.date || ""; days.has(k) || days.set(k, []); days.get(k).push(a); });
      const multi = days.size > 1 || (e.end && e.end !== e.start);
      lineup = [...days.entries()].map(([d, list]) => `
        <div class="day">${multi ? `<span class="day-l">${d ? fmt(d, { weekday: "long", day: "numeric" }) : "Jour à préciser"}</span>` : ""}
          <div class="chips">${list.map((a) => artistChip(a, q)).join("")}</div></div>`).join("");
    } else if (acts.length && (acts.length > 1 || norm(acts[0].artist) !== norm(title(e)))) {
      lineup = `<div class="chips">${acts.map((a) => artistChip(a, q)).join("")}</div>`;
    } else if (acts[0]?.setlist) {
      lineup = `<div class="chips">${artistChip(acts[0], q)}</div>`;
    }
    const setlists = acts.filter((a) => a.setlist);
    const links = setlists.length === 1 && !fest
      ? `<a class="c-link" href="${esc(setlists[0].setlist)}" target="_blank" rel="noopener">Setlist ↗</a>` : "";
    return `<article class="c-card${fest ? " is-fest" : ""}${upcoming(e) ? " is-soon" : ""}" data-id="${e.id}">
      ${dateBlock(e)}
      <div class="c-body">
        <div class="c-head"><h3>${esc(title(e))}</h3>${badges}</div>
        <p class="c-place">${esc(place(e)) || "Lieu à préciser"}${fest && acts.length ? ` · ${plural(acts.length, "artiste")}` : ""}</p>
        ${lineup}
        ${e.comment ? `<p class="c-note">${esc(e.comment)}</p>` : ""}
        ${links}
      </div>
    </article>`;
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

    // Passages de la liste Keep pas encore rattachés à un concert (sans filtre d'année, de type ni de ville)
    const looseVisible = !els.year.value && !els.type.value && !els.city.value;
    const loose = looseVisible ? state.loose.filter((a) => !q || q.split(/\s+/).every((w) => norm(a.artist).includes(w))) : [];
    if (loose.length) {
      html += `<details class="c-loose"${q ? " open" : ""}><summary><h2 class="c-year">Sans date ni lieu <small>${plural(loose.length, "passage")} à compléter dans Notion</small></h2></summary>
        <p class="sub">Artistes vus en concert, pas encore rattachés à une date ni à une salle.</p>
        <div class="chips">${loose.map((a) => artistChip(a, q)).join("")}</div></details>`;
    }
    els.count.textContent = plural(list.length, "concert ou festival", "concerts et festivals") + (q || els.year.value || els.type.value || els.city.value ? " correspondent" : "");
    els.list.innerHTML = html || `<p class="empty">Aucun concert ne correspond.</p>`;
  }

  // Un clic sur un artiste : on cherche tous ses passages
  els.list.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".a-chip");
    if (!chip) return;
    els.q.value = chip.dataset.artist;
    els.year.value = els.type.value = els.city.value = "";
    if (state.view !== "list") setView("list"); else renderList();
    window.scrollTo({ top: $(".tabs").offsetTop - 4, behavior: "smooth" });
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
  const tiles = () => (document.documentElement.dataset.theme === "light" ? "light_all" : "dark_all");

  function venueGroups() {
    const groups = new Map();
    for (const e of seenEvents().concat(state.events.filter(upcoming))) {
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
      g.artists = g.seen.reduce((s, e) => s + Math.max(1, state.byEvent.get(e.id).length), 0);
    }
    return [...groups.values()].sort((a, b) => b.seen.length - a.seen.length || b.artists - a.artists);
  }

  function popupHTML(g) {
    const rows = g.events.map((e) => {
      const acts = state.byEvent.get(e.id);
      const who = e.type === "Festival" ? `${esc(e.name)} <small>(${plural(acts.length, "artiste")})</small>` : esc(acts.map((a) => a.artist).join(", ") || title(e));
      return `<li><span>${e.start ? fmt(e.start, { day: "numeric", month: "short", year: "numeric" }) : "date ?"}</span>${who}${upcoming(e) ? ` <em>à venir</em>` : ""}</li>`;
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
    if (!state.map) {
      state.map = L.map("map", { scrollWheelZoom: false, zoomControl: true });
      state.tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${tiles()}/{z}/{x}/{y}{r}.png`, {
        maxZoom: 18, subdomains: "abcd",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(state.map);
      state.map.on("click", () => state.map.scrollWheelZoom.enable());
    } else {
      state.tiles.setUrl(`https://{s}.basemaps.cartocdn.com/${tiles()}/{z}/{x}/{y}{r}.png`);
    }
    state.layer?.remove();
    state.layer = L.layerGroup().addTo(state.map);
    const max = Math.max(...groups.map((g) => g.seen.length), 1);
    state.markers = groups.map((g) => {
      const soonOnly = !g.seen.length;
      const r = 7 + 13 * Math.sqrt(g.seen.length / max);
      return L.circleMarker([g.lat, g.lng], {
        radius: r, weight: 2, color: soonOnly ? "#a89c8f" : "#ff7a45", fillColor: soonOnly ? "#a89c8f" : "#ff7a45",
        fillOpacity: soonOnly ? 0.25 : 0.55, dashArray: soonOnly ? "3 3" : null,
      }).bindPopup(popupHTML(g), { maxWidth: 300 }).bindTooltip(`${g.name} · ${g.seen.length || "à venir"}`, { direction: "top" }).addTo(state.layer);
    });
    setTimeout(() => {
      state.map.invalidateSize();
      // Vue d'ensemble de la France ; zoom sur Toulouse si toutes les salles y sont
      if (groups.length) state.map.fitBounds(L.latLngBounds(groups.map((g) => [g.lat, g.lng])).pad(0.15), { maxZoom: 11 });
    }, 50);
  }
  $("#venues").addEventListener("click", (ev) => {
    const row = ev.target.closest(".v-row");
    if (!row || !state.markers) return;
    const m = state.markers[+row.dataset.i];
    state.map.flyTo(m.getLatLng(), 14, { duration: 0.8 });
    setTimeout(() => m.openPopup(), 850);
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ---------- Statistiques ----------
  function bars(title, entries, max = Infinity, fmtVal = (v) => v) {
    const rows = entries.slice(0, max);
    if (!rows.length) return "";
    const top = Math.max(...rows.map(([, v]) => v), 1);
    return `<div class="panel"><h3>${title}</h3>${rows.map(([k, v]) => `
      <div class="bar"><span title="${esc(k)}">${esc(k)}</span><div class="track"><div class="fill" style="width:${(v / top) * 100}%"></div></div><b>${fmtVal(v)}</b></div>`).join("")}</div>`;
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
    const todo = acts.filter((a) => !a.event || !(a.date || eventOf(a)?.start)).length;
    const first = dated[0], last = dated[dated.length - 1];
    const next = state.events.filter(upcoming).filter((e) => e.start).sort((a, b) => a.start.localeCompare(b.start))[0];
    const fact = (label, value, sub = "") => `<div class="fact"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

    els.stats.innerHTML =
      `<div class="panel facts">
        ${fact("Premier concert enregistré", first ? esc(title(first)) : "—", first ? fmt(first.start) + " · " + esc(first.city || "") : "")}
        ${fact("Dernier concert", last ? esc(title(last)) : "—", last ? fmt(last.start) + " · " + esc(last.city || "") : "")}
        ${fact("Prochain", next ? esc(title(next)) : "—", next ? fmt(next.start) + " · " + esc(next.city || "") : "")}
        ${fact("Artistes différents", new Set(acts.map((a) => a.artist)).size, `sur ${plural(acts.length, "passage")}`)}
        ${fact("Setlists retrouvées", withSetlist, `sur setlist.fm`)}
        ${fact("Passages à dater", todo, "date ou lieu manquant dans Notion")}
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
    els.mapView.hidden = v !== "map"; els.stats.hidden = v !== "stats";
    if (isList) renderList(); else if (v === "map") renderMap(); else renderStats();
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

  checkAccess();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
