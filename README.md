# 💿 Journal d'écoute

Site récap de mes écoutes d'albums, alimenté par ma base Notion « Base de données - Musiques écoutées ».
Adresse : <https://thomasduf0.github.io/Musique-Thomas/>

- **Version publique / mode privé** : sans mot de passe, le site est en consultation seule : albums écoutés et leurs notes (sans les avis), concerts passés (sans la wantlist ni les concerts à venir), statistiques. Le **cadenas** en haut de page ouvre le mode privé (mot de passe `ADMIN_PASSWORD`, case « Rester connecté ») : avis, À écouter, Conseillés, wantlist, concerts à venir, réglages et toutes les modifications. **Se déconnecter** (en haut à droite, ou dans les Réglages) revient à la version publique.
  - Ce n'est pas qu'un affichage masqué : les fichiers publiés (`data/albums.json`, `data/concerts.json`) ne contiennent que la version publique, et la fonction Cloudflare refuse sans mot de passe les données privées (`/private`, `/export/reviews`, export complet) et toute modification.
  - Les données complètes sont préparées par la synchro horaire et gardées dans la fonction Cloudflare (`/private`). Il faut pour cela le secret GitHub **`ADMIN_PASSWORD`** (même valeur que dans Cloudflare) ; sans lui, seule la version publique est mise à jour.
- **Fiche album** : bouton **Modifier** pour changer la note ou ajouter un commentaire de 2e (3e…) écoute, enregistré à la suite de l'avis dans Notion ; pour un album à écouter, il permet de le marquer comme écouté. La flèche en bas à droite ouvre l'album sur Spotify.
- **Pas intéressé** : sur chaque conseil (carte ou fiche). Le conseil disparaît et n'est plus jamais proposé ; la liste est gardée dans la fonction Cloudflare (`/dismissed`) et la sélection de la semaine est complétée par un autre album.
- **✓ Écouté** : sur chaque album à écouter. Ouvre le formulaire note, date, avis, langue et genres, comme sur la page d'ajout.
- **Page artiste** : un clic sur le nom d'un artiste affiche tous ses albums (écoutés, à écouter, conseillés).
- **À jour tout de suite** : après connexion, le site relit Notion en direct (`/export`) et applique les changements sans attendre la publication horaire.

- **Écoutés** : tous les albums écoutés, filtrables par genre, langue et note, triables par date d'écoute (dans les deux sens), note, sortie ou artiste. Les genres affichés sont ceux d'Apple Music (en français), pas ceux saisis dans Notion.
- **Recherche** (en haut de page) : trouve un album dans ton journal (écouté ou à écouter) ou sur Spotify ; un album Spotify s'ajoute en « ✓ Écouté » (note, date, avis, langue, genres) ou en « + À écouter ».
- **Coups de cœur** : les albums notés 5★.
- **À écouter** : les albums pas encore cochés « Écouté ».
- **Conseillés pour Thomas** : albums studio des artistes écoutés au moins 2 fois et pas encore écoutés (rééditions, deluxe, live, compilations, remix, EP et singles exclus), plus une sélection faite à la main dans `data/selection.json`.
- **Stats** : répartition des notes, genres, langues, écoutes par mois, artistes les plus écoutés.
- **Réglages** (`reglages.html`, roue dentée en haut de page ; `ajouter.html` y redirige) : thème clair, sombre ou automatique, état de Spotify, lien vers Notion, albums « À noter », remplacement des liens par Spotify.
- **Détection d'écoute complète** : toutes les heures, les albums « à écouter » dont toutes les pistes ont été jouées sur Spotify sont cochés « Écouté » avec la date du jour. Une écoute partielle ne coche rien : on le fait à la main depuis la page d'ajout. La note reste toujours à mettre soi-même.

## Concerts (page de test : `concerts.html`)

Page séparée en attendant validation, avec le bouton **Albums / Concerts** qui sera ensuite ajouté en haut de la page d'accueil.

- **Tous les concerts** : par année, avec recherche (artiste, salle, ville) et filtres. Les festivals listent les artistes vus jour par jour ; un clic sur un artiste affiche tous ses passages. Les passages sans date ni lieu sont regroupés en bas.
- **Carte** : les salles où j'ai vu un concert, la taille du point dépend du nombre de sorties. Fond de carte OpenStreetMap / CARTO, bibliothèque Leaflet.
- **Statistiques** : sorties et artistes par année, artistes vus plusieurs fois, salles, villes, festivals, mois.

Les données viennent de la page Notion **Concerts** (bases « Événements » et « Passages ») : `scripts/build-concerts.mjs` les lit via la fonction Cloudflare (`/export/concerts`) et écrit `data/concerts.json`. Les positions des salles sont dans `data/venues.json` : une nouvelle salle est cherchée automatiquement sur OpenStreetMap lors de la synchro, et on peut corriger une position à la main.


| Fichier | Rôle |
|---|---|
| `index.html`, `reglages.html`, `assets/` | Le site (HTML/CSS/JS, sans framework) |
| `assets/config.js` | Adresse de la fonction Cloudflare |
| `data/albums.json`, `covers/` | Les données affichées et les pochettes importées dans Notion |
| `scripts/enrich.mjs` | Genres et pochettes Apple Music (API iTunes, sans clé) et calcul des conseils ; conseils et cache envoyés avec les données privées à la fonction Cloudflare |
| `assets/auth.js` | Version publique / mode privé : cadenas, connexion, déconnexion |
| `scripts/build-data.mjs` | Lit les données (via la fonction Cloudflare) et régénère `data/albums.json` |
| `concerts.html`, `assets/concerts.*`, `scripts/build-concerts.mjs`, `data/concerts.json`, `data/venues.json` | Page Concerts et ses données |
| `worker/` | Fonction Cloudflare : recherche Spotify, écriture dans Notion, détection d'écoute complète, export des données |
| `.github/workflows/deploy.yml` | Synchro toutes les heures + publication sur GitHub Pages |

Le site est public et ne contient aucune clé. Les clés Notion, Spotify et GitHub sont stockées uniquement dans la fonction Cloudflare et dans les secrets GitHub.

## Mise en route

Tout est déjà configuré (fonction Cloudflare `musique-thomas`, stockage KV `musique-state`, app Spotify « Musique Thomas »). Il reste à saisir les 4 secrets dans Cloudflare : *Workers et Pages → musique-thomas → Paramètres → Variables et secrets*, en type **Secret** :

| Nom | Valeur |
|---|---|
| `NOTION_TOKEN` | jeton de l'intégration Notion (<https://www.notion.so/profile/integrations>), connectée à la page **Suivi d'écoutes** |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | app « Musique Thomas » sur <https://developer.spotify.com/dashboard> → *Settings* |
| `ADMIN_PASSWORD` | mot de passe au choix (accès au site) |

Ensuite :

Sur `reglages.html` : **Relier mon compte Spotify**, puis **Remplacer les liens par Spotify** pour la base existante.

La détection d'écoute complète est lancée chaque heure par la synchro GitHub (appel à `/tick`). Un déclencheur cron Cloudflare (`7 * * * *`) peut la remplacer, mais n'est pas nécessaire.

Côté GitHub (*Settings → Secrets and variables → Actions*), le secret **`ADMIN_PASSWORD`** (même mot de passe que dans Cloudflare) permet à la synchro horaire de lire les données complètes et de préparer le mode privé. Facultatif : le secret Cloudflare `GITHUB_TOKEN` (jeton GitHub limité au dépôt, permission *Contents : Read and write*) republie le site dans la minute après un ajout, au lieu de l'heure suivante.

## En local

```bash
node scripts/build-data.mjs          # sans NOTION_TOKEN : utilise l'export initial
NOTION_TOKEN=secret_xxx node scripts/build-data.mjs   # avec Notion
python3 -m http.server 8000          # puis http://localhost:8000
```
