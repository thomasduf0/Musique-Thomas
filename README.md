# 💿 Les écoutes de Thomas

Site récap de mes écoutes d'albums, alimenté par ma base Notion « Base de données - Musiques écoutées ».

- **Écoutés** : tous les albums écoutés, filtrables par genre, langue et note, triables par date d'écoute, note, sortie ou artiste.
- **Coups de cœur** : les albums notés 5★.
- **À écouter** : les albums pas encore cochés « Écouté ».
- **Stats** : répartition des notes, genres, langues, écoutes par mois, artistes les plus écoutés.

Un clic sur un album ouvre sa fiche : note, dates, genres, mon avis (le texte de la page Notion) et le lien Apple Music / Qobuz.

## Fonctionnement

| Fichier | Rôle |
|---|---|
| `index.html`, `assets/` | Le site (HTML/CSS/JS, sans framework) |
| `data/albums.json` | Les données affichées |
| `scripts/build-data.mjs` | Lit Notion, récupère les pochettes (API iTunes) et régénère `data/albums.json` |
| `scripts/seed-rows.json` | Export initial de la base, utilisé tant que Notion n'est pas branché |
| `.github/workflows/deploy.yml` | Synchro quotidienne + publication sur GitHub Pages |

## Mise en route

1. **Activer GitHub Pages** : *Settings → Pages → Build and deployment → Source : GitHub Actions*.
2. **Brancher Notion** (pour la mise à jour automatique) :
   1. Créer une intégration sur <https://www.notion.so/profile/integrations> (type *Interne*, droit de lecture du contenu) et copier son jeton.
   2. Dans Notion, ouvrir la page **Suivi d'écoutes** → `•••` → *Connexions* → ajouter l'intégration.
   3. Dans GitHub : *Settings → Secrets and variables → Actions → New repository secret*, nom `NOTION_TOKEN`, valeur = le jeton.
3. Lancer *Actions → Synchro Notion et publication → Run workflow*.

Ensuite, le site se met à jour tout seul chaque matin. Pour forcer une mise à jour après avoir noté un album, relancer le workflow.

Le site sera à l'adresse : `https://thomasduf0.github.io/musique-thomas/`

## En local

```bash
node scripts/build-data.mjs          # sans NOTION_TOKEN : utilise l'export initial
NOTION_TOKEN=secret_xxx node scripts/build-data.mjs   # avec Notion
python3 -m http.server 8000          # puis http://localhost:8000
```
