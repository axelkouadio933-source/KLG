// =============================================
//  DukaManager SaaS — Backend Server
//  Node.js + Express + SQLite
//  Gère: Auth, IA proxy (clé cachée), Admin
// =============================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const Database   = require('better-sqlite3');
const fetch      = require('node-fetch');
const path       = require('path');
const crypto     = require('crypto');
require('dotenv').config();

const app = express();
const db  = new Database(process.env.DB_PATH || './dukamanager.db');

// ---- CONFIG ----
const JWT_SECRET    = process.env.JWT_SECRET    || crypto.randomBytes(32).toString('hex');
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL   || 'admin@dukamanager.com';
const ADMIN_PASS    = process.env.ADMIN_PASS    || 'admin123';
const PORT          = process.env.PORT          || 3000;

// ---- MIDDLEWARE ----
app.use(cors({ origin: '*', credentials: true }));
// Limite 10MB pour les photos de profil en base64
app.use(express.json({ limit: '10mb' }));
// Servir les fichiers statiques depuis /public (app + admin)
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html']
}));

// ---- BASE DE DONNÉES ----
function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE NOT NULL,
      password      TEXT    NOT NULL,
      nom           TEXT    NOT NULL,
      telephone     TEXT    DEFAULT '',
      photo_profil  TEXT    DEFAULT '',
      bio           TEXT    DEFAULT '',
      pays          TEXT    DEFAULT 'CI',
      monnaie       TEXT    DEFAULT 'FCFA',
      plan          TEXT    DEFAULT 'free',
      credits_ia    INTEGER DEFAULT 100,
      messages_ia   INTEGER DEFAULT 0,
      actif         INTEGER DEFAULT 1,
      banni         INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now')),
      last_login    TEXT,
      last_seen     TEXT
    );

    CREATE TABLE IF NOT EXISTS boutiques (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      nom         TEXT    NOT NULL,
      type        TEXT,
      adresse     TEXT,
      telephone   TEXT,
      pays        TEXT    DEFAULT 'CI',
      monnaie     TEXT    DEFAULT 'FCFA',
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ai_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      boutique_id INTEGER,
      message_user TEXT,
      message_ai   TEXT,
      tokens_used  INTEGER DEFAULT 0,
      created_at   TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ventes_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      boutique_id INTEGER,
      montant     REAL,
      date        TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER,
      titre       TEXT,
      message     TEXT,
      type        TEXT    DEFAULT 'info',
      lu          INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nom         TEXT    UNIQUE NOT NULL,
      credits_ia  INTEGER DEFAULT 100,
      prix_mois   REAL    DEFAULT 0,
      description TEXT
    );

    INSERT OR IGNORE INTO plans (nom, credits_ia, prix_mois, description) VALUES
      ('free',    50,    0,    'Plan gratuit — 50 messages IA / mois'),
      ('basic',   300,   2000, 'Plan Basic — 300 messages IA / mois'),
      ('pro',     1000,  5000, 'Plan Pro — 1000 messages IA / mois'),
      ('illimite',-1,    10000,'Plan Illimité — IA sans limite');
  `);

  // Migration: ajouter colonnes si elles n'existent pas (pour DBs existantes)
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('photo_profil')) db.exec("ALTER TABLE users ADD COLUMN photo_profil TEXT DEFAULT ''");
  if (!cols.includes('telephone'))    db.exec("ALTER TABLE users ADD COLUMN telephone    TEXT DEFAULT ''");
  if (!cols.includes('bio'))          db.exec("ALTER TABLE users ADD COLUMN bio          TEXT DEFAULT ''");

  // Créer le compte admin si inexistant
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (!adminExists) {
    const hashed = bcrypt.hashSync(ADMIN_PASS, 10);
    db.prepare(`INSERT INTO users (email, password, nom, plan, credits_ia) VALUES (?, ?, 'Administrateur', 'illimite', -1)`)
      .run(ADMIN_EMAIL, hashed);
    console.log(`✅ Compte admin créé : ${ADMIN_EMAIL}`);
  }
}

// ---- MIDDLEWARE AUTH ----
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur' });
  }
  next();
}

// ---- AUTH ROUTES ----

// Inscription
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nom, pays, monnaie } = req.body;
    if (!email || !password || !nom) return res.status(400).json({ error: 'Champs obligatoires manquants' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (exists) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hashed = await bcrypt.hash(password, 10);
    const result = db.prepare(
      'INSERT INTO users (email, password, nom, pays, monnaie, credits_ia) VALUES (?, ?, ?, ?, ?, 100)'
    ).run(email.toLowerCase(), hashed, nom, pays || 'CI', monnaie || 'FCFA');

    const userId = result.lastInsertRowid;

    // Créer boutique par défaut
    db.prepare('INSERT INTO boutiques (user_id, nom, pays, monnaie) VALUES (?, ?, ?, ?)')
      .run(userId, `Boutique de ${nom}`, pays || 'CI', monnaie || 'FCFA');

    // Notification de bienvenue
    db.prepare('INSERT INTO notifications (user_id, titre, message, type) VALUES (?, ?, ?, ?)')
      .run(userId, 'Bienvenue sur DukaManager !', `Bonjour ${nom}, votre compte a été créé. Vous disposez de 100 crédits IA gratuits.`, 'success');

    const token = jwt.sign({ id: userId, email: email.toLowerCase(), nom }, JWT_SECRET, { expiresIn: '30d' });
    const user  = db.prepare('SELECT id, email, nom, pays, monnaie, plan, credits_ia, created_at FROM users WHERE id = ?').get(userId);

    res.json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Connexion
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    if (user.banni) return res.status(403).json({ error: 'Compte suspendu. Contactez le support.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    db.prepare('UPDATE users SET last_login = datetime("now"), last_seen = datetime("now") WHERE id = ?').run(user.id);

    const token = jwt.sign({ id: user.id, email: user.email, nom: user.nom }, JWT_SECRET, { expiresIn: '30d' });
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Profil utilisateur
app.get('/api/auth/me', authMiddleware, (req, res) => {
  db.prepare('UPDATE users SET last_seen = datetime("now") WHERE id = ?').run(req.user.id);
  const user = db.prepare(`
    SELECT id, email, nom, telephone, bio, photo_profil, pays, monnaie,
           plan, credits_ia, messages_ia, actif, created_at, last_login
    FROM users WHERE id = ?`).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

// Mettre à jour le profil (nom, bio, téléphone)
app.patch('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { nom, telephone, bio, password_actuel, nouveau_password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Introuvable' });

    let updates = [];
    let params  = [];

    if (nom?.trim())       { updates.push('nom = ?');       params.push(nom.trim()); }
    if (telephone !== undefined) { updates.push('telephone = ?'); params.push(telephone.trim()); }
    if (bio !== undefined)       { updates.push('bio = ?');       params.push(bio.trim()); }

    // Changement de mot de passe
    if (nouveau_password) {
      if (!password_actuel) return res.status(400).json({ error: 'Mot de passe actuel requis' });
      const valid = await bcrypt.compare(password_actuel, user.password);
      if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
      if (nouveau_password.length < 6) return res.status(400).json({ error: 'Nouveau mot de passe trop court' });
      const hashed = await bcrypt.hash(nouveau_password, 10);
      updates.push('password = ?'); params.push(hashed);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

    params.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT id, email, nom, telephone, bio, photo_profil, pays, monnaie, plan, credits_ia FROM users WHERE id = ?').get(req.user.id);
    res.json(updated);
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Upload photo de profil (base64, max ~2MB après compression)
app.post('/api/auth/photo', authMiddleware, (req, res) => {
  try {
    const { photo } = req.body; // data:image/jpeg;base64,...
    if (!photo) return res.status(400).json({ error: 'Photo manquante' });

    // Valider que c'est bien une image base64
    if (!photo.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Format invalide. Utilisez JPEG, PNG ou WebP.' });
    }

    // Vérifier la taille (base64 ~1.37x taille binaire, on limite à ~2MB)
    const sizeBytes = Math.round((photo.length * 3) / 4);
    if (sizeBytes > 2.5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image trop grande. Maximum 2MB. Utilisez une photo de profil compressée.' });
    }

    db.prepare('UPDATE users SET photo_profil = ? WHERE id = ?').run(photo, req.user.id);
    res.json({ success: true, photo });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer la photo de profil
app.delete('/api/auth/photo', authMiddleware, (req, res) => {
  db.prepare("UPDATE users SET photo_profil = '' WHERE id = ?").run(req.user.id);
  res.json({ success: true });
});

// ---- AI PROXY (clé cachée côté serveur) ----
app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  try {
    const user = db.prepare('SELECT credits_ia, messages_ia, plan, banni FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.banni) return res.status(403).json({ error: 'Compte suspendu' });

    // Vérifier les crédits (sauf plan illimité = -1)
    if (user.credits_ia !== -1 && user.credits_ia <= 0) {
      return res.status(402).json({
        error: 'Crédits IA épuisés',
        message: 'Vous avez utilisé tous vos crédits IA. Passez à un plan supérieur pour continuer.',
        credits: 0
      });
    }

    if (!ANTHROPIC_KEY) {
      return res.status(503).json({ error: 'Clé API Anthropic non configurée sur le serveur' });
    }

    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages invalides' });

    // Appel à l'API Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: system || 'Tu es Duka, un assistant IA pour commerçants africains.',
        messages: messages.slice(-16)
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error?.message || 'Erreur API Claude' });
    }

    const data = await response.json();
    const replyText = data.content.map(b => b.text || '').join('');
    const tokensUsed = data.usage?.output_tokens || 0;

    // Décrémenter les crédits (sauf illimité)
    if (user.credits_ia !== -1) {
      db.prepare('UPDATE users SET credits_ia = credits_ia - 1, messages_ia = messages_ia + 1 WHERE id = ?').run(req.user.id);
    } else {
      db.prepare('UPDATE users SET messages_ia = messages_ia + 1 WHERE id = ?').run(req.user.id);
    }

    // Log
    const { boutique_id } = req.body;
    db.prepare('INSERT INTO ai_logs (user_id, boutique_id, message_user, message_ai, tokens_used) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, boutique_id || null, messages[messages.length-1]?.content || '', replyText, tokensUsed);

    const updatedUser = db.prepare('SELECT credits_ia, messages_ia FROM users WHERE id = ?').get(req.user.id);
    res.json({ reply: replyText, credits_restants: updatedUser.credits_ia, messages_ia: updatedUser.messages_ia });

  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'appel à l\'IA: ' + err.message });
  }
});

// ---- ADMIN ROUTES ----

// Stats globales
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const stats = {
    total_users:    db.prepare('SELECT COUNT(*) as n FROM users').get().n,
    actifs_7j:      db.prepare("SELECT COUNT(*) as n FROM users WHERE last_seen > datetime('now', '-7 days')").get().n,
    actifs_30j:     db.prepare("SELECT COUNT(*) as n FROM users WHERE last_seen > datetime('now', '-30 days')").get().n,
    inscrits_auj:   db.prepare("SELECT COUNT(*) as n FROM users WHERE date(created_at) = date('now')").get().n,
    inscrits_7j:    db.prepare("SELECT COUNT(*) as n FROM users WHERE created_at > datetime('now', '-7 days')").get().n,
    total_ai_msgs:  db.prepare('SELECT COUNT(*) as n FROM ai_logs').get().n,
    ai_msgs_auj:    db.prepare("SELECT COUNT(*) as n FROM ai_logs WHERE date(created_at) = date('now')").get().n,
    total_boutiques:db.prepare('SELECT COUNT(*) as n FROM boutiques').get().n,
    plans: {
      free:     db.prepare("SELECT COUNT(*) as n FROM users WHERE plan = 'free'").get().n,
      basic:    db.prepare("SELECT COUNT(*) as n FROM users WHERE plan = 'basic'").get().n,
      pro:      db.prepare("SELECT COUNT(*) as n FROM users WHERE plan = 'pro'").get().n,
      illimite: db.prepare("SELECT COUNT(*) as n FROM users WHERE plan = 'illimite'").get().n,
    },
    tokens_total:   db.prepare('SELECT SUM(tokens_used) as n FROM ai_logs').get().n || 0,
  };

  // Inscriptions par jour (30 derniers jours)
  stats.inscriptions_graph = db.prepare(`
    SELECT date(created_at) as jour, COUNT(*) as n
    FROM users
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY jour ASC
  `).all();

  // Messages IA par jour (30 derniers jours)
  stats.ai_msgs_graph = db.prepare(`
    SELECT date(created_at) as jour, COUNT(*) as n
    FROM ai_logs
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY jour ASC
  `).all();

  res.json(stats);
});

// Liste des utilisateurs
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const { search, plan, page = 1, limit = 50 } = req.query;
  let query = 'SELECT id, email, nom, telephone, photo_profil, pays, plan, credits_ia, messages_ia, actif, banni, created_at, last_login, last_seen FROM users WHERE 1=1';
  const params = [];

  if (search) { query += ' AND (email LIKE ? OR nom LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (plan)   { query += ' AND plan = ?'; params.push(plan); }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));

  const users = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  res.json({ users, total, pages: Math.ceil(total / limit) });
});

// Modifier un utilisateur (plan, crédits, ban)
app.patch('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { plan, credits_ia, actif, banni, nom } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  if (plan !== undefined) {
    const planData = db.prepare('SELECT * FROM plans WHERE nom = ?').get(plan);
    db.prepare('UPDATE users SET plan = ?, credits_ia = ? WHERE id = ?')
      .run(plan, planData?.credits_ia ?? user.credits_ia, req.params.id);

    // Notifier l'utilisateur
    if (plan !== user.plan) {
      db.prepare('INSERT INTO notifications (user_id, titre, message, type) VALUES (?, ?, ?, ?)')
        .run(user.id, 'Plan mis à jour', `Votre plan a été changé vers ${plan}. Crédits IA : ${planData?.credits_ia === -1 ? 'Illimités' : planData?.credits_ia}.`, 'success');
    }
  }
  if (credits_ia !== undefined) db.prepare('UPDATE users SET credits_ia = ? WHERE id = ?').run(credits_ia, req.params.id);
  if (actif !== undefined)     db.prepare('UPDATE users SET actif = ? WHERE id = ?').run(actif ? 1 : 0, req.params.id);
  if (banni !== undefined)     db.prepare('UPDATE users SET banni = ? WHERE id = ?').run(banni ? 1 : 0, req.params.id);
  if (nom !== undefined)       db.prepare('UPDATE users SET nom = ? WHERE id = ?').run(nom, req.params.id);

  const updated = db.prepare('SELECT id, email, nom, plan, credits_ia, actif, banni FROM users WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Supprimer un utilisateur
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  db.prepare('DELETE FROM ai_logs WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM boutiques WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Logs IA
app.get('/api/admin/ai-logs', authMiddleware, adminMiddleware, (req, res) => {
  const { user_id, page = 1, limit = 100 } = req.query;
  let query = `SELECT l.*, u.email, u.nom FROM ai_logs l JOIN users u ON l.user_id = u.id WHERE 1=1`;
  const params = [];
  if (user_id) { query += ' AND l.user_id = ?'; params.push(user_id); }
  query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));
  const logs = db.prepare(query).all(...params);
  res.json(logs);
});

// Envoyer notification à tous les utilisateurs
app.post('/api/admin/notify-all', authMiddleware, adminMiddleware, (req, res) => {
  const { titre, message, type = 'info' } = req.body;
  if (!titre || !message) return res.status(400).json({ error: 'Titre et message requis' });
  const users = db.prepare('SELECT id FROM users WHERE banni = 0').all();
  const stmt  = db.prepare('INSERT INTO notifications (user_id, titre, message, type) VALUES (?, ?, ?, ?)');
  users.forEach(u => stmt.run(u.id, titre, message, type));
  res.json({ sent: users.length });
});

// Réinitialiser les crédits IA (mensuellement)
app.post('/api/admin/reset-credits', authMiddleware, adminMiddleware, (req, res) => {
  const plans = db.prepare('SELECT * FROM plans').all();
  plans.forEach(p => {
    if (p.nom !== 'illimite') {
      db.prepare(`UPDATE users SET credits_ia = ? WHERE plan = ?`).run(p.credits_ia, p.nom);
    }
  });
  res.json({ success: true, message: 'Crédits réinitialisés pour tous les utilisateurs' });
});

// ---- NOTIFICATIONS UTILISATEUR ----
app.get('/api/notifications', authMiddleware, (req, res) => {
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json(notifs);
});
app.patch('/api/notifications/:id/lu', authMiddleware, (req, res) => {
  db.prepare('UPDATE notifications SET lu = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});
app.patch('/api/notifications/tout-lire', authMiddleware, (req, res) => {
  db.prepare('UPDATE notifications SET lu = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

// ---- BOUTIQUES ----
app.get('/api/boutiques', authMiddleware, (req, res) => {
  const boutiques = db.prepare('SELECT * FROM boutiques WHERE user_id = ?').all(req.user.id);
  res.json(boutiques);
});
app.post('/api/boutiques', authMiddleware, (req, res) => {
  const { nom, type, adresse, telephone, pays, monnaie } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const result = db.prepare('INSERT INTO boutiques (user_id, nom, type, adresse, telephone, pays, monnaie) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, nom, type, adresse, telephone, pays || 'CI', monnaie || 'FCFA');
  res.json({ id: result.lastInsertRowid, nom, type, adresse, telephone, pays, monnaie, user_id: req.user.id });
});
app.patch('/api/boutiques/:id', authMiddleware, (req, res) => {
  const { nom, adresse, telephone, monnaie } = req.body;
  const b = db.prepare('SELECT * FROM boutiques WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Boutique introuvable' });
  if (nom)       db.prepare('UPDATE boutiques SET nom = ? WHERE id = ?').run(nom, b.id);
  if (adresse !== undefined) db.prepare('UPDATE boutiques SET adresse = ? WHERE id = ?').run(adresse, b.id);
  if (telephone !== undefined) db.prepare('UPDATE boutiques SET telephone = ? WHERE id = ?').run(telephone, b.id);
  if (monnaie)   db.prepare('UPDATE boutiques SET monnaie = ? WHERE id = ?').run(monnaie, b.id);
  res.json(db.prepare('SELECT * FROM boutiques WHERE id = ?').get(b.id));
});

// ---- HEALTH CHECK ----
app.get('/api/health', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  res.json({
    status: 'ok',
    version: '3.0',
    ai_configured: !!ANTHROPIC_KEY,
    users: userCount,
    timestamp: new Date().toISOString()
  });
});

// ---- SPA FALLBACK (doit être EN DERNIER après toutes les routes API) ----
// Toutes les routes qui ne commencent pas par /api renvoient vers le bon HTML
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
// L'app principale pour toutes les autres routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route API introuvable' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- DÉMARRAGE ----
initDB();
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       DukaManager IA — Serveur v3.0         ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`🚀  URL principale  : http://localhost:${PORT}`);
  console.log(`🛡  Admin           : http://localhost:${PORT}/admin`);
  console.log(`📧  Admin email     : ${ADMIN_EMAIL}`);
  console.log(`🤖  IA Claude       : ${ANTHROPIC_KEY ? '✅ Configurée' : '❌ MANQUANTE — ajoutez ANTHROPIC_KEY dans .env'}`);
  console.log(`\n💡  Pour démarrer en production : npm start`);
  console.log(`📄  Logs disponibles dans la console\n`);
  if (!ANTHROPIC_KEY) {
    console.log('⚠️  ATTENTION : L\'IA ne fonctionnera pas sans clé API Anthropic.');
    console.log('   → Obtenez votre clé sur https://console.anthropic.com');
    console.log('   → Ajoutez ANTHROPIC_KEY=sk-ant-... dans le fichier .env\n');
  }
});

module.exports = app;

