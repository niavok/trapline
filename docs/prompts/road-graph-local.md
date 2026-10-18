# Prompt : graphe routier IDF en local

À coller dans Claude Code, lancé à la racine d'un clone du dépôt sur ton PC
(il faut Node 22+, ~2 Go de disque libre et 8 Go de RAM).

---

Tu travailles sur le dépôt `trapline` (optimiseur de tournée shopping en
Île-de-France). Lis `docs/ARCHITECTURE.md` puis `src/lib/roads/` et
`scripts/roads/`. Le code, les noms et les commentaires restent en anglais ;
tu me réponds en français.

Objectif : construire le graphe routier OSM de l'Île-de-France, mesurer sa
taille et sa vitesse, puis le calibrer pour que les temps en voiture soient
réalistes (« à la louche » : ±15 % suffit).

Étapes :

1. `npm install`, puis `npm test` et `npm run typecheck` : tout doit passer
   avant de commencer.
2. `npm run roads:download` (extrait Geofabrik, ~300 Mo).
3. `npm run roads:build`. Note la durée, la mémoire max, le nombre de nœuds et
   d'arêtes et la taille de `data/roads/idf-roads.bin`. Ce code n'a jamais
   tourné sur l'extrait complet : si ça plante (mémoire, parseur, format des
   tags…), corrige à la racine, ajoute un test unitaire qui reproduit le
   problème sur des données factices, et relance.
   Construis aussi la variante `npm run roads:build -- --no-local` (sans les
   rues résidentielles) dans un fichier à part, et compare taille, vitesse et
   précision (étape 5) des deux variantes. Recommande-m'en une.
4. Copie `data/roads/places.example.json` en `places.json` et
   `reference-trips.example.json` en `reference-trips.json`. **Demande-moi**
   les coordonnées de mon domicile (« Home ») et fais-moi vérifier les
   coordonnées des centres commerciaux (elles sont approximatives). Demande-moi
   ensuite les temps que je connais (au moins Home ⇄ Belle Épine, Home → Val
   d'Europe, Home → Carré Sénart, Home → Vélizy 2) et remplis
   `reference-trips.json`.
5. `npm run roads:bench` : affiche la matrice entre les lieux et l'écart avec
   mes temps. Vérifie qu'aucun lieu n'est à plus de 300 m du graphe.
6. Si j'ai une clé Google (demande-moi ; sinon saute cette étape) :
   `GOOGLE_MAPS_API_KEY=... npm run roads:sample` mesure tous les couples de
   lieux un samedi à 11 h (n × (n − 1) appels, 72 pour 9 lieux, dans le quota
   gratuit). Ne mets jamais la clé dans un fichier versionné.
7. `npm run roads:calibrate`. Regarde les vitesses effectives obtenues : si
   l'une est absurde (autoroute à 130 km/h en moyenne, nationale plus rapide
   que l'autoroute…), c'est du sur-apprentissage : augmente
   `--prior-weight`, ou ajoute des trajets, plutôt que d'accepter le résultat.
   Relance `npm run roads:bench` pour confirmer l'erreur finale.
8. Fais-moi un rapport court : taille et temps de build, ms par Dijkstra,
   temps pour une matrice de 40 points, erreur moyenne avant / après
   calibration, et les 3 trajets les plus faux avec une hypothèse sur la cause
   (bouchons, sens unique, accroche au mauvais côté d'une autoroute…).
9. Commits (sur la branche courante, messages en anglais) : les corrections de
   code et leurs tests, `data/roads/drive-params.json`,
   `data/roads/places.json` **sans** mon domicile (remplace-le par
   `"lat": 0, "lng": 0`), et les trajets de référence sans le domicile. Ne
   versionne pas l'extrait OSM. Pour `idf-roads.bin` : versionne-le seulement
   s'il fait moins de 50 Mo, sinon dis-le-moi et on choisira un stockage
   (Vercel Blob, Git LFS).
