// Thème clair / sombre (Réglages → Apparence). Chargé dans <head> pour éviter un flash.
(() => {
  let pref = "dark";
  try { pref = localStorage.getItem("musique:theme") || "dark"; } catch {}
  const mq = matchMedia("(prefers-color-scheme: light)");
  const apply = () => {
    const t = pref === "auto" ? (mq.matches ? "light" : "dark") : pref;
    document.documentElement.dataset.theme = t;
  };
  apply();
  mq.addEventListener?.("change", () => pref === "auto" && apply());
  window.setTheme = (p) => {
    pref = p;
    try { localStorage.setItem("musique:theme", p); } catch {}
    apply();
  };
  window.getThemePref = () => pref;
})();
