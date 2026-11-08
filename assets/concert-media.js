// Photos et vidéos des concerts : mosaïque dans la fiche, visionneuse plein écran,
// et en mode privé, envoi par glisser-déposer.
// Avant l'envoi, tout est préparé dans le navigateur (rien à faire à la main) :
//   - photos : converties en JPEG (y compris les HEIC d'iPhone), 2560 px maximum, + une vignette ;
//   - vidéos : réencodées en 1080p H.264/AAC (lisibles partout, ~30-50 Mo par minute), + une vignette.
// Les fichiers sont stockés dans Cloudflare R2 via la fonction Cloudflare (/media).
(() => {
  const API = (window.MUSIQUE_API || "").replace(/\/$/, "");
  const Auth = window.MusiqueAuth;
  const PRIV = !!Auth?.isPrivate;
  const MEDIABUNNY = "https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/+esm";
  const HEIC2ANY = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
  const EXIFR = "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js";
  const PHOTO_MAX = 2560, THUMB_MAX = 640, VIDEO_SHORT_SIDE = 1080;
  const SINGLE_LIMIT = 90 * 1024 * 1024, PART = 50 * 1024 * 1024;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fileUrl = (key) => `${API}/media/f/${key}`;
  const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
  const sortItems = (list) => [...list].sort((a, b) => (a.taken || a.added || "").localeCompare(b.taken || b.added || ""));

  let index = {};
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn());

  async function load() {
    try {
      const res = await fetch(`${API}/media`);
      if (res.ok) { index = await res.json(); changed(); }
    } catch {}
  }

  // ---------- Petites aides de chargement ----------
  const scripts = {};
  function script(src) {
    return (scripts[src] ||= new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Chargement impossible : " + src));
      document.head.appendChild(s);
    }));
  }
  let mb;
  const mediabunny = () => (mb ||= import(MEDIABUNNY));

  function canvasBlob(source, w, h, max, quality) {
    const r = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * r); c.height = Math.round(h * r);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return new Promise((ok, ko) => c.toBlob((b) => (b ? ok({ blob: b, w: c.width, h: c.height }) : ko(new Error("Image illisible"))), "image/jpeg", quality));
  }

  // Date de prise de vue (EXIF des photos, métadonnées des vidéos), sinon date du fichier
  async function photoDate(file) {
    try {
      await script(EXIFR);
      const d = await window.exifr.parse(file, ["DateTimeOriginal", "CreateDate"]);
      const v = d?.DateTimeOriginal || d?.CreateDate;
      if (v instanceof Date && !isNaN(v)) return v.toISOString();
    } catch {}
    return file.lastModified ? new Date(file.lastModified).toISOString() : null;
  }

  // ---------- Préparation d'une photo ----------
  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
  async function decodeImage(file) {
    try { return await createImageBitmap(file); } // Safari lit les HEIC directement
    catch (e) {
      if (!isHeic(file)) throw new Error("Format de photo non pris en charge");
      await script(HEIC2ANY);
      const jpg = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      return createImageBitmap(Array.isArray(jpg) ? jpg[0] : jpg);
    }
  }
  async function preparePhoto(file, step) {
    step("Préparation…");
    const taken = await photoDate(file);
    const bmp = await decodeImage(file);
    const main = await canvasBlob(bmp, bmp.width, bmp.height, PHOTO_MAX, 0.86);
    const thumb = await canvasBlob(bmp, bmp.width, bmp.height, THUMB_MAX, 0.78);
    bmp.close?.();
    return { kind: "photo", blob: main.blob, ext: "jpg", thumb: thumb.blob, w: main.w, h: main.h, dur: null, taken };
  }

  // ---------- Préparation d'une vidéo ----------
  async function compressVideo(file, step) {
    const M = await mediabunny();
    const input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(file) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("Aucune image dans cette vidéo");
    let taken = null;
    try { const tags = await input.getMetadataTags(); if (tags?.date instanceof Date && !isNaN(tags.date)) taken = tags.date.toISOString(); } catch {}
    const dw = await track.getDisplayWidth(), dh = await track.getDisplayHeight();
    const r = Math.min(1, VIDEO_SHORT_SIDE / Math.min(dw, dh));
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const width = even(dw * r), height = even(dh * r);
    const make = async (qualityKey) => {
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
      const q = M.QUALITY_HIGH ? { [qualityKey]: M.QUALITY_HIGH } : {};
      const qa = M.QUALITY_MEDIUM ? { [qualityKey]: M.QUALITY_MEDIUM } : {};
      const conversion = await M.Conversion.init({
        input, output,
        video: (t) => (t.number > 1 ? { discard: true } : { width, height, fit: "fill", codec: "avc", ...q, forceTranscode: true, allowTransformationMetadata: false }),
        audio: (t) => (t.number > 1 ? { discard: true } : { codec: "aac", ...qa }),
      });
      return { output, conversion };
    };
    let job;
    try { job = await make("quality"); } catch (e) { job = await make("bitrate"); } // selon la version de la bibliothèque
    if (!job.conversion.isValid) throw new Error("Ce navigateur ne sait pas compresser cette vidéo");
    job.conversion.onProgress = (p) => step(`Compression… ${Math.round(p * 100)} %`);
    await job.conversion.execute();
    return { blob: new Blob([job.output.target.buffer], { type: "video/mp4" }), taken, width, height };
  }

  function videoInfo(blob) {
    return new Promise((ok, ko) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      const url = URL.createObjectURL(blob);
      const done = (fn, x) => { URL.revokeObjectURL(url); fn(x); };
      v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); };
      v.onseeked = async () => {
        try {
          const t = await canvasBlob(v, v.videoWidth, v.videoHeight, THUMB_MAX, 0.78);
          done(ok, { thumb: t.blob, w: v.videoWidth, h: v.videoHeight, dur: v.duration });
        } catch (e) { done(ko, e); }
      };
      v.onerror = () => done(ko, new Error("Vidéo illisible dans ce navigateur"));
      v.src = url;
    });
  }

  async function prepareVideo(file, step) {
    step("Compression… 0 %");
    let blob, ext = "mp4", taken = null;
    try {
      const c = await compressVideo(file, step);
      blob = c.blob; taken = c.taken;
      if (blob.size > file.size && /mp4$/i.test(file.name)) blob = file; // déjà plus léger que la version compressée
    } catch (e) {
      // Navigateur sans compression vidéo : on envoie l'original s'il n'est pas trop lourd
      console.warn(e);
      if (file.size > 300 * 1024 * 1024) throw new Error("Compression impossible dans ce navigateur (essaie avec Chrome)");
      blob = file; ext = /\.mov$/i.test(file.name) ? "mov" : /\.webm$/i.test(file.name) ? "webm" : "mp4";
    }
    step("Vignette…");
    const info = await videoInfo(blob);
    if (!taken) taken = file.lastModified ? new Date(file.lastModified).toISOString() : null;
    return { kind: "video", blob, ext, thumb: info.thumb, w: info.w, h: info.h, dur: info.dur, taken };
  }

  // ---------- Envoi vers la fonction Cloudflare ----------
  function xhr(method, url, body, onProgress) {
    return new Promise((ok, ko) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      Object.entries(Auth.headers()).forEach(([k, v]) => x.setRequestHeader(k, v));
      if (body && !(body instanceof Blob)) x.setRequestHeader("Content-Type", "application/json");
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded);
      x.onload = () => {
        let data = {}; try { data = JSON.parse(x.responseText); } catch {}
        if (x.status === 401) { Auth.expired(); return ko(Object.assign(new Error("Mot de passe refusé"), { auth: true })); }
        x.status < 300 ? ok(data) : ko(new Error(data.error || `Erreur ${x.status}`));
      };
      x.onerror = () => ko(new Error("Connexion interrompue"));
      x.send(body instanceof Blob ? body : body ? JSON.stringify(body) : null);
    });
  }
  async function putFile(key, blob, onProgress) {
    if (blob.size <= SINGLE_LIMIT) return xhr("PUT", `${API}/media/put?key=${encodeURIComponent(key)}`, blob, onProgress);
    const q = `key=${encodeURIComponent(key)}`;
    const { uploadId } = await xhr("POST", `${API}/media/mpu/create?${q}`);
    const parts = [];
    for (let i = 0, n = 1; i < blob.size; i += PART, n++) {
      parts.push(await xhr("PUT", `${API}/media/mpu/part?${q}&uploadId=${encodeURIComponent(uploadId)}&part=${n}`, blob.slice(i, i + PART), (l) => onProgress?.(i + l)));
    }
    return xhr("POST", `${API}/media/mpu/complete?${q}&uploadId=${encodeURIComponent(uploadId)}`, { parts });
  }

  // File d'attente : un fichier à la fois (la compression vidéo occupe tout le processeur)
  const queue = [];
  let running = false;
  function enqueue(eventId, files, ui) {
    for (const file of files) {
      const kind = /^video\//.test(file.type) || /\.(mov|mp4|m4v|webm)$/i.test(file.name) ? "video"
        : /^image\//.test(file.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name) ? "photo" : null;
      if (!kind) { ui.add(file.name).fail("Format non pris en charge"); continue; }
      queue.push({ eventId, file, kind, row: ui.add(file.name) });
    }
    run();
  }
  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      const { eventId, file, row } = job;
      try {
        const p = await (job.kind === "video" ? prepareVideo(file, row.step) : preparePhoto(file, row.step));
        const id = crypto.randomUUID();
        const base = `events/${eventId}/${id}`;
        const item = { id, kind: p.kind, file: `${base}.${p.ext}`, thumb: `${base}.thumb.jpg`, w: p.w, h: p.h, dur: p.dur, taken: p.taken, size: p.blob.size, name: file.name };
        const total = p.blob.size + p.thumb.size;
        await putFile(item.thumb, p.thumb, (l) => row.step(`Envoi… ${Math.round((l / total) * 100)} %`));
        await putFile(item.file, p.blob, (l) => row.step(`Envoi… ${Math.round(((p.thumb.size + l) / total) * 100)} %`));
        const res = await xhr("POST", `${API}/media/add`, { event: eventId, item });
        (index[eventId] ||= []).push(res.item);
        row.done(`${(p.blob.size / 1048576).toFixed(1).replace(".", ",")} Mo`);
        changed();
      } catch (e) {
        console.error(e);
        row.fail(e.auth ? "Reconnecte-toi puis recommence" : e.message || "Échec");
      }
    }
    running = false;
  }

  // ---------- Affichage dans la fiche ----------
  function tileHTML(m, i) {
    const ratio = m.w && m.h ? m.w / m.h : 1;
    return `<button type="button" class="m-tile${ratio > 1.3 ? " wide" : ""}" data-i="${i}" aria-label="${m.kind === "video" ? "Vidéo" : "Photo"} ${i + 1}">
      <img src="${fileUrl(m.thumb)}" alt="" loading="lazy" decoding="async">
      ${m.kind === "video" ? `<span class="m-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>${esc(dur(m.dur))}</span>` : ""}
    </button>`;
  }

  // groups : [{ label, match(item) }] pour les festivals (un groupe par jour) ; sinon une seule mosaïque
  function render(container, eventId, groups = null) {
    const items = sortItems(index[eventId] || []);
    container.dataset.event = eventId;
    if (!items.length && !PRIV) { container.innerHTML = ""; return; }
    let grid = "";
    if (groups && items.length) {
      const used = new Set();
      for (const g of groups) {
        const part = items.filter((m) => !used.has(m) && g.match(m));
        if (!part.length) continue;
        part.forEach((m) => used.add(m));
        grid += `<p class="m-day">${esc(g.label)}</p><div class="m-grid">${part.map((m) => tileHTML(m, items.indexOf(m))).join("")}</div>`;
      }
      const rest = items.filter((m) => !used.has(m));
      if (rest.length) grid += `${grid ? `<p class="m-day">Autres</p>` : ""}<div class="m-grid">${rest.map((m) => tileHTML(m, items.indexOf(m))).join("")}</div>`;
    } else if (items.length) grid = `<div class="m-grid">${items.map(tileHTML).join("")}</div>`;
    const photos = items.filter((m) => m.kind === "photo").length, videos = items.length - photos;
    const counts = [photos && `${photos} photo${photos > 1 ? "s" : ""}`, videos && `${videos} vidéo${videos > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
    container.innerHTML = `<h3 class="d-sub">Photos et vidéos <small>${counts}</small></h3>
      ${grid}
      ${PRIV ? `<label class="m-drop">
        <input type="file" accept="image/*,video/*,.heic,.heif,.mov" multiple hidden>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span><b>Glisse ici tes photos et vidéos</b> ou clique pour les choisir<br><small>Compression et vignettes automatiques · tu peux continuer à naviguer sur la page pendant l'envoi</small></span>
      </label>` : ""}`;
    container._items = items;
    if (PRIV) bindDrop(container, eventId);
  }

  // La liste des envois en cours survit aux réaffichages de la fiche
  const queues = {};
  function bindDrop(container, eventId) {
    const drop = container.querySelector(".m-drop");
    const list = (queues[eventId] ||= Object.assign(document.createElement("ul"), { className: "m-queue" }));
    drop.after(list);
    const ui = {
      add(name) {
        const li = document.createElement("li");
        li.innerHTML = `<span class="m-q-name">${esc(name)}</span><span class="m-q-state">En attente…</span>`;
        list.appendChild(li);
        const st = li.querySelector(".m-q-state");
        return {
          step: (t) => { st.textContent = t; },
          done: (t) => { li.classList.add("ok"); st.textContent = "✓ " + t; setTimeout(() => li.remove(), 6000); },
          fail: (t) => { li.classList.add("err"); st.textContent = t; },
        };
      },
    };
    drop.querySelector("input").addEventListener("change", (e) => { enqueue(eventId, [...e.target.files], ui); e.target.value = ""; });
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); enqueue(eventId, [...e.dataTransfer.files], ui); });
  }

  // ---------- Visionneuse plein écran ----------
  let lb, lbItems = [], lbI = 0, lbEvent = null;
  function lightbox() {
    if (lb) return lb;
    lb = document.createElement("dialog");
    lb.className = "m-lb";
    lb.innerHTML = `
      <div class="m-lb-stage"></div>
      <button type="button" class="m-lb-btn m-lb-close" aria-label="Fermer">×</button>
      <button type="button" class="m-lb-btn m-lb-prev" aria-label="Précédent">‹</button>
      <button type="button" class="m-lb-btn m-lb-next" aria-label="Suivant">›</button>
      <div class="m-lb-bar"><span class="m-lb-count"></span>${PRIV ? `<button type="button" class="m-lb-del">Supprimer</button>` : ""}</div>`;
    document.body.appendChild(lb);
    lb.querySelector(".m-lb-close").onclick = () => lb.close();
    lb.querySelector(".m-lb-prev").onclick = () => show(lbI - 1);
    lb.querySelector(".m-lb-next").onclick = () => show(lbI + 1);
    lb.addEventListener("click", (e) => { if (e.target === lb || e.target.classList.contains("m-lb-stage")) lb.close(); });
    lb.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") show(lbI - 1); if (e.key === "ArrowRight") show(lbI + 1); });
    lb.addEventListener("close", () => { lb.querySelector(".m-lb-stage").innerHTML = ""; });
    let x0 = null;
    lb.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener("touchend", (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) show(lbI + (dx < 0 ? 1 : -1));
    });
    lb.querySelector(".m-lb-del")?.addEventListener("click", async (e) => {
      const m = lbItems[lbI];
      if (!m || !confirm("Supprimer ce média du site ? (l'original reste dans ta photothèque)")) return;
      e.target.disabled = true;
      try {
        await xhr("DELETE", `${API}/media/item?event=${lbEvent}&id=${m.id}`);
        index[lbEvent] = (index[lbEvent] || []).filter((x) => x.id !== m.id);
        lbItems = lbItems.filter((x) => x.id !== m.id);
        changed();
        if (!lbItems.length) lb.close(); else show(Math.min(lbI, lbItems.length - 1));
      } catch (err) { alert(err.message); }
      finally { e.target.disabled = false; }
    });
    return lb;
  }
  function show(i) {
    if (!lbItems.length) return;
    lbI = (i + lbItems.length) % lbItems.length;
    const m = lbItems[lbI], stage = lb.querySelector(".m-lb-stage");
    stage.innerHTML = m.kind === "video"
      ? `<video src="${fileUrl(m.file)}" poster="${fileUrl(m.thumb)}" controls autoplay playsinline preload="metadata"></video>`
      : `<img src="${fileUrl(m.file)}" alt="">`;
    lb.querySelector(".m-lb-count").textContent = `${lbI + 1} / ${lbItems.length}`;
    lb.querySelectorAll(".m-lb-prev, .m-lb-next").forEach((b) => (b.hidden = lbItems.length < 2));
    // Précharge la photo suivante
    const next = lbItems[(lbI + 1) % lbItems.length];
    if (next?.kind === "photo") new Image().src = fileUrl(next.file);
  }
  function open(eventId, items, i) {
    lightbox(); lbEvent = eventId; lbItems = items;
    if (!lb.open) lb.showModal();
    show(i);
  }
  document.addEventListener("click", (e) => {
    const tile = e.target.closest(".m-tile");
    if (!tile) return;
    const box = tile.closest("[data-event]");
    open(box.dataset.event, box._items || [], Number(tile.dataset.i));
  });

  // Un fichier lâché à côté de la zone ne doit pas ouvrir la photo à la place du site
  if (PRIV) ["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => { if (!e.target.closest?.(".m-drop")) e.preventDefault(); }));

  window.ConcertMedia = {
    load, render,
    items: (eventId) => sortItems(index[eventId] || []),
    thumb: (eventId) => { const m = sortItems(index[eventId] || [])[0]; return m ? fileUrl(m.thumb) : null; },
    onChange: (fn) => listeners.add(fn),
  };
})();
