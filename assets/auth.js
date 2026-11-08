// Version publique / mode privé, commun à toutes les pages.
// - Sans mot de passe : consultation seule (albums écoutés et leurs notes, concerts passés).
// - Avec le mot de passe (cadenas en haut de page) : tout le journal, avec les avis, la wantlist, les conseils
//   et les modifications. La fonction Cloudflare refuse de toute façon toute modification sans mot de passe.
// Chargé dans <head> : la classe « is-private » est posée avant l'affichage, sans clignotement.
(() => {
  const KEY = "musique:pw";
  const safe = (fn, fallback = "") => { try { return fn(); } catch { return fallback; } };
  const read = () => safe(() => localStorage.getItem(KEY)) || safe(() => sessionStorage.getItem(KEY)) || "";
  let password = read();
  const root = document.documentElement;
  root.classList.toggle("is-private", !!password);

  const api = () => (window.MUSIQUE_API || "").replace(/\/$/, "");
  function save(pw, remember = true) {
    password = pw;
    safe(() => (remember ? localStorage : sessionStorage).setItem(KEY, pw));
    safe(() => (remember ? sessionStorage : localStorage).removeItem(KEY));
  }
  function clear() {
    password = "";
    safe(() => localStorage.removeItem(KEY)); safe(() => sessionStorage.removeItem(KEY));
    safe(() => localStorage.removeItem("musique:ok"));
  }
  // Vérifie un mot de passe auprès de la fonction Cloudflare : true, false, ou null si injoignable
  async function check(pw) {
    try {
      const res = await fetch(api() + "/status", { headers: { "X-Password": pw } });
      return res.ok ? true : res.status === 401 ? false : null;
    } catch { return null; }
  }

  const ICON_LOCK = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const ICON_OPEN = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

  // ---------- Fenêtre de connexion ----------
  let dlg = null;
  function openLogin(msg = "") {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "detail login-dlg";
      dlg.innerHTML = `
        <button class="close" type="button" aria-label="Fermer" data-close>×</button>
        <form class="gate-box" method="dialog">
          <span class="gate-logo" aria-hidden="true">${ICON_LOCK}</span>
          <h2>Mode privé</h2>
          <p>Entre le mot de passe pour voir tout le journal et le modifier.</p>
          <input name="pw" type="password" placeholder="Mot de passe" autocomplete="current-password" required aria-label="Mot de passe">
          <label class="remember"><input name="remember" type="checkbox" checked> Rester connecté sur cet appareil</label>
          <button class="btn">Se connecter</button>
          <p class="gate-err" role="alert"></p>
        </form>`;
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
      dlg.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target, err = f.querySelector(".gate-err"), btn = f.querySelector(".btn");
        err.textContent = "Vérification…"; btn.disabled = true;
        const ok = await check(f.pw.value);
        btn.disabled = false;
        if (ok) { save(f.pw.value, f.remember.checked); location.reload(); return; }
        err.textContent = ok === false ? "Mot de passe incorrect." : "Vérification impossible pour le moment, réessaie dans un instant.";
        f.pw.select();
      });
    }
    dlg.querySelector(".gate-err").textContent = msg;
    if (!dlg.open) dlg.showModal();
    setTimeout(() => dlg.querySelector("input[name=pw]").focus(), 30);
  }

  function logout() { clear(); location.reload(); }
  // Mot de passe refusé lors d'une action (changé entre-temps) : retour à la version publique
  function expired() { clear(); root.classList.remove("is-private"); openLogin("Mot de passe refusé : reconnecte-toi."); }

  // ---------- En-tête ----------
  // Version publique : un cadenas à côté de la recherche ouvre la connexion.
  // Mode privé : en haut à droite, le repère « Mode privé » et le bouton « Se déconnecter ».
  function mountButton() {
    if (!password) {
      const bar = document.querySelector(".hero-actions");
      if (!bar || bar.querySelector(".lock-btn")) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon-btn lock-btn";
      b.title = "Mode privé";
      b.setAttribute("aria-label", "Se connecter (mode privé)");
      b.innerHTML = ICON_LOCK;
      b.addEventListener("click", () => openLogin());
      bar.appendChild(b);
      return;
    }
    const sw = document.querySelector(".hero .switch");
    if (!sw || sw.parentElement.classList.contains("top-row")) return;
    const row = document.createElement("div");
    row.className = "top-row";
    sw.replaceWith(row);
    row.appendChild(sw);
    row.insertAdjacentHTML("beforeend", `<div class="priv-bar">
      <span class="priv-chip">${ICON_OPEN}Mode privé</span>
      <button type="button" class="lock-btn on" title="Revenir à la version publique">Se déconnecter</button>
    </div>`);
    row.querySelector(".lock-btn").addEventListener("click", logout);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountButton);
  else mountButton();

  // Mot de passe enregistré mais changé depuis : on repasse en version publique
  if (password) {
    window.addEventListener("load", async () => {
      if (api() && (await check(password)) === false) { clear(); location.reload(); }
    });
  }

  window.MusiqueAuth = {
    get isPrivate() { return !!password; },
    get password() { return password; },
    headers: () => (password ? { "X-Password": password } : {}),
    save, clear, check, openLogin, logout, expired,
  };
})();
