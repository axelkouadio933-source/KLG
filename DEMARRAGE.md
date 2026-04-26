# DukaManager IA v3.0
## Guide de démarrage rapide

═══════════════════════════════════════════

## Structure du projet

```
dukamanager-final/
├── server.js          ← Serveur principal (Node.js + Express)
├── package.json       ← Dépendances
├── .env               ← ⚠️ VOS CLÉS SECRÈTES (à configurer)
├── dukamanager.db     ← Base de données (créée automatiquement)
└── public/
    ├── index.html     ← Application commerçants
    ├── manifest.json  ← Config PWA (installable sur mobile)
    ├── sw.js          ← Service Worker (mode hors-ligne)
    └── admin/
        └── index.html ← Tableau de bord administrateur (VOUS)
```

═══════════════════════════════════════════

## ÉTAPE 1 — Configurer .env

Ouvrez le fichier `.env` et remplissez :

```
ANTHROPIC_KEY=sk-ant-VOTRE-CLÉ-ICI
JWT_SECRET=une-longue-chaine-secrete
ADMIN_EMAIL=votre@email.com
ADMIN_PASS=VotreMotDePasse123!
```

→ Clé Anthropic : https://console.anthropic.com → API Keys → Create Key

## ÉTAPE 2 — Installer les dépendances

```bash
npm install
```

## ÉTAPE 3 — Démarrer le serveur

```bash
npm start
```

Vous verrez :
```
╔══════════════════════════════════════════════╗
║       DukaManager IA — Serveur v3.0         ║
╚══════════════════════════════════════════════╝

🚀  URL principale  : http://localhost:3000
🛡  Admin           : http://localhost:3000/admin
📧  Admin email     : votre@email.com
🤖  IA Claude       : ✅ Configurée
```

═══════════════════════════════════════════

## ACCÈS AUX APPLICATIONS

| Application | URL |
|-------------|-----|
| App commerçants | http://localhost:3000 |
| Tableau de bord admin | http://localhost:3000/admin |

═══════════════════════════════════════════

## DÉPLOIEMENT EN LIGNE (Railway — gratuit)

1. Créez un compte sur https://railway.app
2. "New Project" → "Deploy from GitHub" → importez ce dossier
3. Ajoutez les variables d'environnement dans Railway :
   - ANTHROPIC_KEY
   - JWT_SECRET
   - ADMIN_EMAIL
   - ADMIN_PASS
4. Votre app sera en ligne sur une URL railway.app

═══════════════════════════════════════════

## CE QUE FAIT CHAQUE FICHIER

**server.js** — Le cerveau :
- Authentification (inscription, connexion, tokens)
- Proxy IA (votre clé Anthropic est CACHÉE, jamais exposée)
- Gestion des crédits IA par utilisateur
- Photos de profil (stockées en base64 dans SQLite)
- API admin (stats, gestion users, logs IA, notifications)

**public/index.html** — L'app commerçants :
- Interface complète (ventes, stock, clients, factures, IA...)
- Données locales (IndexedDB = ultra-rapide, hors-ligne)
- Appelle le serveur uniquement pour : auth + IA + photo profil

**public/admin/index.html** — Votre espace privé :
- Vue d'ensemble (utilisateurs, messages IA, graphiques)
- Gestion des utilisateurs (changer plan, crédits, bannir)
- Logs de toutes les conversations IA
- Envoi de notifications à tous les utilisateurs
