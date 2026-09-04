# Margin Explorer — passation / handoff

**Branche :** `margin-explorer-evolution` · HEAD : voir `git log -1` · 22 commits au-dessus de `master`
**Preview Vercel :** https://vieforce-hq-git-margin-explorer-e-8d6384-mathieu-7782s-projects.vercel.app/app.html
**Production :** intacte. `master` est toujours sur `548dd3d`. Rien n'a été fusionné.

Ce document est écrit pour quelqu'un qui reprend le travail sans avoir suivi la conversation.
Il dit ce qui a changé, pourquoi, ce qu'il ne faut pas casser, et ce qui reste à faire.

---

## 1. La décision du propriétaire

Après avoir vu une refonte complète de la page, Mathieu a tranché :

> « Il ne faut pas tout changer, juste change ce que je te dis de changer. »

La page reste la page. **Quatre changements**, plus une option approuvée. Tout le reste est
identique à `master`. Une refonte plus large avait été construite puis **retirée** de la branche
(commits `00ab43d`, `25f411a`, `d4fa386`) — ne pas la réintroduire.

### ① La boîte « Drill Matrix » devient la matrice 12 mois par catégorie

`js/mexp2-panel-trendmatrix.js` — lignes = catégories produit (SSG) avec le tonnage sous le nom,
une colonne par mois, mois en cours en pointillé, ligne AVG prise du payload (jamais recalculée).

- Unité : ₱/t · GM % · GP (dérivé, étiqueté comme tel) · MT
- Fenêtre : 12 derniers mois (défaut) ou les mois de la période sélectionnée
- **Garde-fou tonnage** : une cellule sous 5 MT affiche un tiret + le tonnage en infobulle, jamais
  un ₱/t. C'est ce qui produisait « Untagged ₱4 519 296/t » sur la page d'origine.
- Cinq filtres **locaux à la boîte** (client-side, ils ne dupliquent pas la barre de filtres de la
  page) : *Moving* (≥1,5 écart-type de sa propre moyenne 12 mois, mois complets, cellules <5 MT
  exclues) · tri (volume/dernier mois/variation 3 mois/volatilité) · seuil min MT · multi-sélection
  de catégories · colonne « vs N-1 » là où c'est comparable
- Clic sur une ligne → filtre la page sur cette catégorie ; clic sur une cellule → ce mois devient
  l'ancre du bridge (`ref_month`)
- Onglet **Snapshot** = l'ancien Drill Matrix (`js/margin-explorer-matrix.js`), pied de tableau
  sur une seule base

### ② La boîte « GM/ton Bridge » : fiable et réactive

`js/mexp2-panel-bridge.js` — waterfall **SVG**, plus de canvas Chart.js.

Le canvas rendait une boîte vide en production alors que les données étaient bien arrivées (les
tableaux Cost / Product Mix en dessous étaient remplis). Le SVG se redessine à chaque changement,
suit le thème sans JavaScript, et affiche **toujours un état** : chargement · « pas de bridge pour
ce scope » avec la raison serveur · « Showing previous scope: … » pendant un rechargement.

- Axe cadré sur les deltas (pas de `beginAtZero`) ; ancres Prior/Current en chiffres, pas en barres
- Les deux tableaux de réconciliation (Cost → RM/Packaging/Feedtag, Product Mix par SSG) sont
  conservés tels quels sous le graphe (`renderBridgeDrills` dans `margin-explorer.js`)

### ③ Les commentaires en petits caractères retirés

Le paragraphe sous le bridge devient **trois badges** — `partial · N of M days`, `mix unstable`
(seulement si `sign_stable` est faux ou `churn_dominated`), `reconciled` — avec un bouton
« details » qui révèle le texte complet. Supprimés : la note de bas du bridge net, la note des
lenses, la double légende du tableau d'ingrédients (une seule ligne désormais).

### ④ La partie basse : plus grande, sans redondance

Avant, les mêmes chiffres apparaissaient trois fois (barres CSS, tableau Reported/Net, ligne
« Discount wedge ») et quatre tableaux de lenses en 11 px.

- **Un** bridge net (variante de `mexp2-panel-bridge.js`) dessiné avec le même SVG, sur la **même
  échelle** que le bridge reporté (domaine union) — les deux se comparent à l'œil
- Une bande de **trois chiffres** : Δ reporté · Δ remise · Δ réalisé
- Les **quatre lenses de composition** (Catégorie · BU · Région · Client) sous le bridge net, en grille
  2×2 de cartes du shell (revenues le 2026-09-04 à la demande de Mathieu, à la place du tableau de
  drivers à sélecteur) : barre d'effet signée depuis un zéro centré, **une seule échelle** pour les
  quatre lenses, « dumbbell » de part avant → après, paire GM/t, avatar initiales, tags NEW / GONE
  quand une entité n'existe que d'un côté, total de la lens en sous-KPI. 7 lignes max par |effet|,
  BU masquée quand une seule BU est filtrée. Un `<table>` en layout fixe par carte.
- Au-dessus des lignes de chaque lens, un **quadrant** : abscisse = décalage de part (pp), ordonnée =
  GM/t après moins le GM/t courant du scope, bulle = tonnage, couleur = signe de l'effet. Haut-droite =
  gain de part là où ça paie ; bas-droite = dilution. Survol d'une ligne ↔ bulle. Clic sur une ligne
  Région / BU / Client applique le filtre de la page via `applyScope` (Catégorie n'est pas un filtre
  serveur, pas de clic). L'en-tête de la lens dit « 7 of 12 rows · 63 % of tonnage » = couverture des
  lignes affichées (somme de leurs parts après).

### Option approuvée

Cinquième carte KPI **« GM / kg net of discount »** à côté de « GM / kg », depuis
`discount_overlay.gm_per_kg_net_of_discount`. Tiret + « not computed » quand le bloc est nul.
La grille passe à 5 colonnes ≥1100 px. Les quatre cartes d'origine sont **inchangées**.

---

## 2. Le fait métier qui justifie tout ça

`INV1.LineTotal` est **net de la remise de ligne mais brut de la remise d'en-tête**
(`OINV.DiscSum`). Le commentaire du backend le vérifie : `DocTotal = SUM(LineTotal) − DiscSum +
VatSum + TotalExpns` réconcilie sur **10 555 factures sur 10 555** en 2026.

Donc **toutes** les marges affichées (`hero.gm_per_kg`, `gross_profit`, `matrix.gp`) sont
**avant remise hors facture** — environ **12 % au-dessus** de la marge réalisée. Et le champ
s'appelle `net_sales`, ce qui n'aide pas.

Le chiffre honnête est **déjà calculé sur chaque réponse** dans `discount_overlay` et n'était lu
nulle part. D'où la cinquième carte et le bridge net.

Cas réel observé (juillet → août 2026) : le bridge **reporté** dit −202 ₱/t, le bridge **réalisé**
dit +8 ₱/t. Une baisse de prix catalogue compensée par une baisse de rabais. La vue reportée
appelle ça une érosion ; ce n'en est pas une.

---

## 3. Corrections de bugs incluses (ce sont des réparations, pas des changements)

Douze défauts trouvés lors d'une revue du code d'origine, corrigés dans les commits `febc1ab`
à `a0b16d7` :

| # | Défaut | Correction |
|---|---|---|
| 1 | Clic sur une ligne du Drill Matrix inerte — `onRowClick(r.dim, r)` contre `onRowClick(row)` | `matrix.js:240` |
| 2 | Fuite de scope : le graphe d'une région restait affiché sous les filtres d'une autre, légendé « source busy » | `resetStaleGuards()` au changement de scope ; message qui **nomme** le scope affiché |
| 3 | Trois politiques de fraîcheur différentes selon les panneaux | Unifiées |
| 4 | Pied du Drill Matrix mélangeant GP global et tonnage des lignes visibles, part figée à 100 % | Une seule base, « Visible rows (N) » |
| 5 | `--border` et `--surface2` référencés partout, définis nulle part → 5 bordures disparaissaient | Définis dans `app.html` (dark + light) |
| 6 | Les graphes ne suivaient pas le thème (couleurs rgba blanches en dur) | MutationObserver sur `data-theme` + couleurs depuis les tokens |
| 7 | Le bloc dissection débordait du padding de la page | Monté dans `.mexp-wrap` |
| 8 | Le badge « Updating » restait « ⚠ update failed » pour toujours | Reconstruit à chaque activation |
| 9 | Verts/rouges en dur (`#22c55e`) au lieu des tokens | `var(--green)` etc. |
| 10 | `beginAtZero` écrasait les barres du bridge à 1 % de la hauteur | Min/max durs sur l'enveloppe cumulée |
| 11 | Deux séries ₱/tonne sur deux axes auto-échelonnés indépendants | ⚠️ **restauré à la version `master` (deux axes)** en `c52141d` — hors des quatre changements |
| 12 | Code mort : `MEXP_renderBridge`, `MEXP_renderTrend`, `\|\| true` | Supprimés |

Le bouton « AI read » passe désormais par `window.apiPost` au lieu d'un `fetch` nu, ce qui lui
donne la gestion de session et le chemin 401 → logout. Techniquement hors des quatre changements,
gardé comme réparation — à signaler si ce n'est pas voulu.

---

## 4. Architecture : comment les nouveaux modules s'intègrent

Les modules `mexp2-*` sont des IIFE ES5 autonomes sur `window.MEXP2`, avec leurs propres tokens
CSS `--mx2-*`. Ils **ne remplacent pas** le contrôleur v1 : ils sont montés dedans.

```
js/margin-explorer.js  (contrôleur v1, conservé)
   │  garde : barre de filtres, barre de période, 4 cartes KPI, tableau d'ingrédients,
   │          bouton AI read, renderBridgeDrills, applyScope
   │
   ├── js/mexp2-adapter.js ─── vmFromV1(coreRaw, dissRaw, scope) → view model du contrat
   │        appelle MEXP2.api.mapCore / mapDissection (les mappeurs conformes au wire)
   │        expose applyScope, renderAll, renderStaleAll, setStatusAll
   │
   ├── #mexp-matrix-host  → MEXP2.panel("trendmatrix")   ① la matrice + onglet Snapshot
   └── #mexp-bridge-host  → MEXP2.panel("bridge")        ② le bridge reporté
       #mexp-net-host     → MEXP2.panel("netbridge")             ④ le bas de page
```

**Ordre de chargement** (tel qu'il est dans `app.html`) :
`mexp2-contract → wire → fmt → store → api → svg → charts → panel-bridge → panel-trendmatrix →
adapter`, puis les fichiers `margin-explorer*.js`. Contraintes réelles : `store` (qui définit
`MEXP2.panel`) avant les deux panneaux ; tous les `mexp2-*` avant `margin-explorer*.js`. L'adaptateur
et les panneaux ne se référencent qu'à l'exécution, leur ordre relatif est libre.

| Fichier | Rôle |
|---|---|
| `js/mexp2-wire.js` | La forme **réelle** de la réponse API, dérivée du code backend. La seule description du wire. |
| `js/mexp2-contract.js` | Le view-model, les six états de rendu, le cycle de vie des panneaux, les constantes. |
| `js/mexp2-api.js` | `normalise()` / `mapCore` / `mapDissection` — **le seul code qui connaît le wire**. Un renommage de champ se corrige ici et nulle part ailleurs. Aucun effet de bord au chargement. |
| `js/mexp2-store.js` | État unique, clé de scope, canal typé `vm.prev` pour le scope précédent. |
| `js/mexp2-svg.js` | Waterfall, bullet, sparkline — SVG à la main, se re-thème sans JS. |
| `js/mexp2-fmt.js` | Tous les formateurs. Rien d'autre ne formate un nombre. |
| `js/mexp2-charts.js` | Registre Chart.js privé (reconstruit au changement de thème). |
| `test/mexp2-mock.js` | 6 scénarios à la forme réelle du wire + chargeur de fixtures. |

---

## 5. Faits vérifiés sur l'API (ne pas les redécouvrir)

Tirés d'une lecture complète de `api/margin-explorer.js` et `api/lib/*` :

- `matrix.rows` **n'est jamais tronqué** (pas de TOP/LIMIT). `Σ rows[].kg / 1000` est le tonnage
  exact du scope — `hero` ne porte **aucun** champ de volume.
- Les lignes à tonnage nul renvoient **`0`, pas `null`**. Tester `kg === 0`.
- `canonical_bridge` / `net_bridge` sont un **vrai indicateur de Bennet** (poids croisés en
  moyenne arithmétique, split de mix symétrique) — **exact par construction**. Les barres sont
  **pré-arrondies**, donc un résidu client ne peut être qu'une dérive d'arrondi (~3 ₱/t), jamais
  un échec de décomposition.
- Le `bridge` de phase A est une décomposition **différente** (hybride Paasche/Laspeyres) où un
  changement de clientèle fuit dans la barre Prix. **Ne pas confondre les deux.**
- La remise est allouée **au prorata de la valeur de ligne**, pas du tonnage.
- `group_by` accepte : `region, bu, dsm, brand, species, sales_group, ssg, customer, sku`.
  Un `group_by` inconnu retombe silencieusement sur `sales_group`.
- **Filtres acceptés : `region`, `bu`, `customer` uniquement.** `dsm` est une dimension de
  regroupement, **pas** un filtre — d'où le filtrage client-side étiqueté comme tel.
- Signaux de confiance calculés par le backend et longtemps ignorés : `mix_ordering.sign_stable`
  (faux ⇒ le split client/produit est un artefact — un mois il faisait passer une barre de −251 à
  +3 ₱/t), `mix_detail.churn_dominated`, `significance.verdict`.
- `meta.window` a un **bug de fuseau** (`toISOString`) et peut être en avance d'un jour.
  Préférer `hero.compare_window` et `dissection.window`.
- `hero` et `dissection` sont des **univers différents** : groupes d'articles (103,105,102) contre
  103 seul avec avoirs nettés. **Ils ne se réconcilient pas.**
- Les ancres de la dissection sont une **paire de mois** (premier et dernier mois complets), pas
  la période sélectionnée. Une sélection YTD produit un bridge janvier→août.

---

## 6. Tester sans accès à l'API

La page est derrière un login et l'API renvoie 401 sans session. D'où le harnais :

```
test/margin-explorer-harness.html    charge le VRAI contrôleur avec test/mexp2-mock.js
```

Sélecteur de scénario (happy / empty-scope / malformed / bridge-unavailable / rounding-drift /
trust-signals) et bascule de thème identique à celle du shell. Voir `test/README.md`.

`file://` est bloqué : servir en local (n'importe quel serveur statique à la racine du dépôt),
puis ouvrir `/test/margin-explorer-harness.html`.

**Contraintes à respecter** — le code est en **ES5** (`var`, déclarations de fonctions ; pas de
fonctions fléchées, littéraux gabarits, `let`/`const`, chaînage optionnel, spread, `class`,
déstructuration) parce que le shell l'est. Pas de nouvel hôte externe (CSP). Pas d'étape de build.
Thème : le shell met `data-theme` à la **chaîne vide** pour le sombre et `"light"` pour le clair —
palette sombre complète sur `:root`, surcharges claires sous `[data-theme="light"]` uniquement.
`[data-theme="dark"]` ne correspond **jamais**.

---

## 7. Ce qui reste à faire

### Décisions du propriétaire

1. **Fusionner en production ?** Un push sur `master` déclenche le déploiement (Vercel + API
   Cloud Run via CI). À faire seulement après validation de la preview avec de vraies données.
2. **Types de remise.** `OINV.DiscSum` est un seul seau. Un fichier `discount-probe.sql` (8
   SELECT en lecture seule) a été remis à Mathieu : il révèle les champs UDF sur OINV/INV1/ORIN,
   la distribution des taux de remise, les avoirs par type et compte GL. Tant qu'il n'est pas
   exécuté, on ne peut pas décomposer la remise par motif.

### Changements backend spécifiés, non implémentés

- **B1** — accepter `dsm` comme filtre (la jointure OSLP existe déjà pour `group_by=dsm`).
  Débloque le filtre DSM côté serveur.
- **B2** — exposer la remise de ligne (`PriceBefDi × Quantity − LineTotal`) et les avoirs
  financiers séparément. Rend possible un vrai bridge brut → net.
- **B3** — généraliser le cube mensuel à n'importe quelle dimension (aujourd'hui SSG seulement).
  Permettrait des lignes par région/BU/DSM/client dans la matrice.
- **B4** — annuler `gm_ton`/`gm_pct` à la source quand `tons < 5 MT`.

### Points mineurs connus

- `css/mexp2.css` contient encore des sections mortes pour les panneaux retirés (`.mx2-g2n-*`,
  `.mx2-kpi-*`) — inoffensif, laissé en place pour ne pas déborder du périmètre.
- `renderWindow` réaffiche `meta.window` (décalage de fuseau possible d'un jour).
- La note `compare_note` sous les KPI est encore en 10 px (version `master`).
- L'annulation de requête est un garde de séquence, pas un `AbortController` (`js/api.js` n'en
  expose pas) — une réponse dépassée est ignorée, pas annulée au niveau réseau.

### Deux points de sécurité soulevés, non résolus

1. **Trois dépôts publics** : `vieforce-hq`, `vieforce-patrol`, `vpi-dashboard`. Aucun secret
   n'est commité (vérifié : `.gitignore` correct, `.env.example` vide, `CLAUDE.md` expurgé).
   Ce qui est exposé est de la reconnaissance : hôte SAP, port, noms de bases, nom d'utilisateur,
   et tout le SQL.
2. **La connexion SAP n'est pas chiffrée.** `api/_db.js` utilise `encrypt: false,
   trustServerCertificate: true` vers `analytics.vienovo.ph:4444`. Si cet hôte est joignable
   depuis Internet, tout le jeu de données commercial transite en clair. Un correctif
   (`encrypt: true`) a été proposé et **non autorisé** : à confirmer avec l'administrateur SQL
   d'abord, sinon la connexion tombe.

---

## 8. Repères rapides

```
Branche          margin-explorer-evolution   (22 commits au-dessus de master)
Production       master @ 548dd3d — jamais touché
Preview          https://vieforce-hq-git-margin-explorer-e-8d6384-mathieu-7782s-projects.vercel.app/app.html
                 (double connexion : Vercel, puis le login VieForce)
Harnais          test/margin-explorer-harness.html  (servir en localhost)
Contrat API      js/mexp2-wire.js
Seam wire        js/mexp2-api.js — normalise() / mapCore / mapDissection
```

**Reprise 2026-09-04** — commits `dabc3e8` → `8bd4ca7` : les boîtes `mexp2` portent désormais le thème du
shell (tokens `--mx2-*` résolus sur ceux du shell, cartes verre, chips de la page), les quatre lenses sont
revenues (voir ④), et la page a gagné une entrée en cascade, des pastilles de delta sur les KPI, un halo
derrière les cartes, une barre de filtres collante. CSS + panneau JS seulement, contrôleur v1 intact.
La branche a été vérifiée en local : les six
scénarios du harnais tournent sans erreur console (Chromium headless), matrice, bridge reporté,
bridge net, bande de trois chiffres, drivers et cinquième carte KPI rendent tous. Le correctif
`animation:false` resté non commité sur `master` local (canvas Chart.js vide, 08-27) est rendu
caduc par cette branche : le bridge n'utilise plus de canvas.

Les commits `febc1ab` → `a0b16d7` sont les corrections de bugs ; `cbddbab` → `db2cff5` la greffe
et la refonte (partiellement annulée ensuite) ; `00ab43d` → `c52141d` la retaille aux quatre
changements. Lire `git log --oneline master..HEAD` dans cet ordre donne l'historique complet.
