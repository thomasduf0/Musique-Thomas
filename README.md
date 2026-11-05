# 💿 Les écoutes de Thomas

Site récap de mes écoutes d'albums, alimenté par ma base Notion « Base de données - Musiques écoutées ».
Adresse : <https://thomasduf0.github.io/Musique-Thomas/>

- **Écoutés** : tous les albums écoutés, filtrables par genre, langue et note, triables par date d'écoute, note, sortie ou artiste.
- **Coups de cœur** : les albums notés 5★.
- **À écouter** : les albums pas encore cochés « Écouté ».
- **Stats** : répartition des notes, genres, langues, écoutes par mois, artistes les plus écoutés.
- **Ajouter un album** (`ajouter.html`, protégé par mot de passe) : recherche sur Spotify, puis création de la fiche dans Notion avec la pochette en en-tête et le lien Spotify.
- **Détection d'écoute complète** : toutes les heures, les albums « à écouter » dont toutes les pistes ont été jouées sur Spotify sont cochés « Écouté » avec la date du jour. Une écoute partielle ne coche rien : on le fait à la main depuis la page d'ajout. La note reste toujours à mettre soi-même.

## Fonctionnement

| Fichier | Rôle |
|---|---|
| `index.html`, `ajouter.html`, `assets/` | Le site (HTML/CSS/JS, sans framework) |
| `assets/config.js` | Adresse de la fonction Cloudflare |
| `data/albums.json`, `covers/` | Les données affichées et les pochettes importées dans Notion |
| `scripts/build-data.mjs` | Lit Notion (propriétés, pochette d'en-tête, avis) et régénère `data/albums.json` |
| `worker/` | Fonction Cloudflare : recherche Spotify, écriture dans Notion, détection d'écoute complète |
| `.github/workflows/deploy.yml` | Synchro (chaque matin, ou à chaque ajout) + publication sur GitHub Pages |

Le site est public et ne contient aucune clé. Les clés Notion, Spotify et GitHub sont stockées uniquement dans la fonction Cloudflare et dans les secrets GitHub.

## Mise en route

### 1. Notion

1. Sur <https://www.notion.so/profile/integrations>, créer une intégration *Interne* avec les droits **Lire**, **Mettre à jour** et **Insérer du contenu**. Copier son jeton.
2. Dans Notion, ouvrir la page **Suivi d'écoutes** → `•••` → *Connexions* → ajouter l'intégration.
3. Dans GitHub : *Settings → Secrets and variables → Actions → New repository secret*, nom `NOTION_TOKEN`, valeur = le jeton.

### 2. Spotify

1. Sur <https://developer.spotify.com/dashboard>, *Create app*.
2. *Redirect URI* : `https://musique-thomas.TON-SOUS-DOMAINE.workers.dev/spotify/callback` (l'adresse exacte s'affiche à l'étape 3, on peut la corriger ensuite dans *Settings*).
3. API utilisée : **Web API**. Copier le *Client ID* et le *Client secret*.

### 3. Fonction Cloudflare (gratuite)

1. Créer un compte sur <https://dash.cloudflare.com>, puis *Workers & Pages → Create → Worker*, nom `musique-thomas`, *Deploy*.
2. *Edit code* : remplacer tout le contenu par celui de `worker/src/index.js`, puis *Deploy*.
3. *Storage & Databases → KV → Create* un espace nommé `musique-state`. Dans le Worker : *Settings → Bindings → Add → KV namespace*, nom de variable **`STATE`**, espace `musique-state`.
4. *Settings → Variables and Secrets* :
   - variables (texte) : `ALLOWED_ORIGIN` = `https://thomasduf0.github.io`, `NOTION_DATA_SOURCE_ID` = `2a4a7bc0-f6df-80c3-bd83-000b2fd1b71e`, `GITHUB_REPO` = `thomasduf0/Musique-Thomas` ;
   - secrets : `ADMIN_PASSWORD` (au choix), `NOTION_TOKEN`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, et facultativement `GITHUB_TOKEN` (voir plus bas).
5. *Settings → Trigger events → Add → Cron* : `7 * * * *` (toutes les heures).
6. Copier l'adresse du Worker (`https://musique-thomas.….workers.dev`) dans `assets/config.js`.

`GITHUB_TOKEN` permet de republier le site dans la minute après un ajout. Sans lui, les ajouts apparaissent à la synchro du matin. Pour le créer : GitHub → *Settings → Developer settings → Fine-grained tokens*, accès au seul dépôt `Musique-Thomas`, permission **Contents : Read and write**.

Alternative en ligne de commande : `cd worker`, compléter `wrangler.toml` (id KV), `npx wrangler secret put …` pour chaque secret, puis `npx wrangler deploy`.

### 4. Relier Spotify

Ouvrir `ajouter.html`, entrer le mot de passe, puis cliquer sur **Relier mon compte Spotify**. La détection d'écoute complète démarre à partir de ce moment.

## En local

```bash
node scripts/build-data.mjs          # sans NOTION_TOKEN : utilise l'export initial
NOTION_TOKEN=secret_xxx node scripts/build-data.mjs   # avec Notion
python3 -m http.server 8000          # puis http://localhost:8000
```
