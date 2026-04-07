
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 9 * * *';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'abostop.db');
const db = new sqlite3.Database(dbPath);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'Sonstiges',
    price REAL DEFAULT 0,
    billing_cycle TEXT DEFAULT 'monatlich',
    renewal_date TEXT NOT NULL,
    notice_days INTEGER DEFAULT 14,
    provider_email TEXT,
    contract_id TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS reminder_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    reminder_date TEXT NOT NULL,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent',
    note TEXT,
    UNIQUE(subscription_id, reminder_date),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
  )`);

  const cols = await all(`PRAGMA table_info(reminder_logs)`);
  if (!cols.find((c) => c.name === 'note')) {
    await run('ALTER TABLE reminder_logs ADD COLUMN note TEXT');
  }
}

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Ungültiger Login.' });
  }
}

function monthlyEquivalent(item) {
  const price = Number(item.price || 0);
  switch (item.billing_cycle) {
    case 'jährlich': return price / 12;
    case 'vierteljährlich': return price / 3;
    default: return price;
  }
}

function getReminderDate(item) {
  const renewal = new Date(`${item.renewal_date}T12:00:00`);
  renewal.setDate(renewal.getDate() - Number(item.notice_days || 0));
  return renewal;
}

function daysBetween(date) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / 86400000);
}

function getStatus(item) {
  const diff = daysBetween(getReminderDate(item));
  if (diff <= 0) return 'kritisch';
  if (diff <= 7) return 'bald';
  return 'ok';
}

function buildTemplate(item) {
  const today = new Date().toLocaleDateString('de-DE');
  const contractLine = item.contract_id ? `Vertragsnummer/Kundennummer: ${item.contract_id}
` : '';
  const emailLine = item.provider_email ? `An: ${item.provider_email}
` : '';
  return `${emailLine}Betreff: Kündigung meines Abonnements ${item.name}

Sehr geehrte Damen und Herren,

hiermit kündige ich mein Abonnement "${item.name}" fristgerecht zum nächstmöglichen Termin.

${contractLine}Bitte bestätigen Sie mir die Kündigung unter Angabe des Beendigungszeitpunkts schriftlich.

Mit freundlichen Grüßen

[Vorname Nachname]
[Adresse]
[E-Mail]

Erstellt am: ${today}`;
}

function getMailerConfigStatus() {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
  const missing = required.filter((key) => !process.env[key]);
  return { ok: missing.length === 0, missing };
}

function createTransporter() {
  const status = getMailerConfigStatus();
  if (!status.ok) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

async function sendMail({ to, subject, html, text }) {
  const cfg = getMailerConfigStatus();
  if (!cfg.ok) {
    throw new Error(`SMTP nicht konfiguriert: ${cfg.missing.join(', ')}`);
  }

  const transporter = createTransporter();
  await transporter.verify();
  return transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    html,
    text
  });
}

async function sendDueReminders(options = {}) {
  const { userId = null, forceTodayOnly = true } = options;
  const cfg = getMailerConfigStatus();
  if (!cfg.ok) {
    const message = `Reminder-Lauf übersprungen: SMTP ist nicht konfiguriert (${cfg.missing.join(', ')})`;
    console.log(message);
    return { success: false, message, sent: 0, due: 0, checked: 0, errors: [] };
  }

  const subscriptions = await all(`
    SELECT s.*, u.email AS user_email, u.name AS user_name
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    ${userId ? 'WHERE s.user_id = ?' : ''}
  `, userId ? [userId] : []);

  const todayIso = new Date().toISOString().slice(0, 10);
  const result = { success: true, message: 'Reminder-Lauf ausgeführt.', sent: 0, due: 0, checked: subscriptions.length, errors: [], items: [] };

  for (const item of subscriptions) {
    const reminderIso = getReminderDate(item).toISOString().slice(0, 10);
    const isDue = forceTodayOnly ? reminderIso === todayIso : reminderIso <= todayIso;
    if (!isDue) continue;

    result.due += 1;

    const existing = await get(
      'SELECT id, status FROM reminder_logs WHERE subscription_id = ? AND reminder_date = ?',
      [item.id, reminderIso]
    );
    if (existing) {
      result.items.push({ id: item.id, name: item.name, status: 'bereits-geloggt', reminderDate: reminderIso });
      continue;
    }

    const subject = `Kündigungsfrist heute: ${item.name}`;
    const monthly = monthlyEquivalent(item).toFixed(2).replace('.', ',');
    const plain = [
      `Hallo ${item.user_name},`,
      '',
      `für dein Abo ${item.name} ist heute der relevante Kündigungstag.`,
      `Verlängerung: ${item.renewal_date}`,
      `Kündigungsfrist: ${item.notice_days} Tage`,
      `Monatlicher Gegenwert: ${monthly} €`,
      '',
      buildTemplate(item),
      '',
      `App: ${APP_BASE_URL}`
    ].join('
');
    const html = `
      <h2>Kündigungsfrist erreicht</h2>
      <p>Hallo ${item.user_name},</p>
      <p>für dein Abo <strong>${item.name}</strong> ist heute der relevante Kündigungstag.</p>
      <ul>
        <li>Verlängerung: ${item.renewal_date}</li>
        <li>Kündigungsfrist: ${item.notice_days} Tage</li>
        <li>Monatlicher Gegenwert: ${monthly} €</li>
      </ul>
      <p>Vorschlag:</p>
      <pre>${buildTemplate(item)}</pre>
      <p>Öffne deine App: <a href="${APP_BASE_URL}">${APP_BASE_URL}</a></p>
    `;

    try {
      const info = await sendMail({ to: item.user_email, subject, html, text: plain });
      await run(
        'INSERT INTO reminder_logs (subscription_id, reminder_date, status, note) VALUES (?, ?, ?, ?)',
        [item.id, reminderIso, 'sent', info.messageId || 'ok']
      );
      result.sent += 1;
      result.items.push({ id: item.id, name: item.name, status: 'sent', reminderDate: reminderIso });
      console.log(`Reminder gesendet für ${item.name} an ${item.user_email}`);
    } catch (error) {
      const err = error && error.message ? error.message : String(error);
      console.error(`Reminder-Fehler für ${item.name}: ${err}`);
      await run(
        'INSERT OR IGNORE INTO reminder_logs (subscription_id, reminder_date, status, note) VALUES (?, ?, ?, ?)',
        [item.id, reminderIso, 'error', err.slice(0, 400)]
      );
      result.errors.push({ id: item.id, name: item.name, error: err });
      result.items.push({ id: item.id, name: item.name, status: 'error', reminderDate: reminderIso, error: err });
    }
  }

  if (!result.due) {
    result.message = 'Reminder-Lauf ausgeführt, aber heute war kein Abo fällig.';
  } else if (!result.sent && !result.errors.length) {
    result.message = 'Reminder-Lauf ausgeführt, aber alle fälligen Erinnerungen waren bereits protokolliert.';
  } else if (result.errors.length) {
    result.success = false;
    result.message = `Reminder-Lauf mit Fehlern beendet (${result.errors.length}).`;
  } else {
    result.message = `${result.sent} Erinnerungs-Mail(s) gesendet.`;
  }

  return result;
}

async function sendTestMailForUser(user) {
  const subject = 'AboStop Testmail';
  const plain = [
    `Hallo ${user.name},`,
    '',
    'das ist eine Testmail von AboStop.',
    'Wenn du diese Mail siehst, funktionieren Render + Brevo + SMTP.',
    '',
    `Zeit: ${new Date().toLocaleString('de-DE')}`,
    `App: ${APP_BASE_URL}`
  ].join('
');

  const html = `
    <h2>AboStop Testmail</h2>
    <p>Hallo ${user.name},</p>
    <p>wenn du diese Mail siehst, funktionieren <strong>Render + Brevo + SMTP</strong>.</p>
    <ul>
      <li>Zeit: ${new Date().toLocaleString('de-DE')}</li>
      <li>Empfänger: ${user.email}</li>
    </ul>
    <p><a href="${APP_BASE_URL}">App öffnen</a></p>
  `;

  const info = await sendMail({ to: user.email, subject, html, text: plain });
  console.log(`Testmail gesendet an ${user.email}`);
  return { messageId: info.messageId || null, to: user.email };
}

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, E-Mail und Passwort sind Pflicht.' });
  }

  const existing = await get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: 'E-Mail bereits registriert.' });

  const hash = await bcrypt.hash(password, 10);
  const result = await run(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
    [name, email.toLowerCase(), hash]
  );
  const user = { id: result.id, name, email: email.toLowerCase() };
  return res.json({ token: signToken(user), user });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await get('SELECT * FROM users WHERE email = ?', [(email || '').toLowerCase()]);
  if (!user) return res.status(401).json({ error: 'Login fehlgeschlagen.' });

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Login fehlgeschlagen.' });

  return res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email }
  });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const user = await get('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.user.userId]);
  res.json({ user });
});

app.get('/api/subscriptions', auth, async (req, res) => {
  const items = await all(
    'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY renewal_date ASC',
    [req.user.userId]
  );
  const enriched = items.map((item) => ({
    ...item,
    status: getStatus(item),
    monthlyEquivalent: monthlyEquivalent(item),
    yearlyEquivalent: monthlyEquivalent(item) * 12,
    reminderDate: getReminderDate(item).toISOString().slice(0, 10)
  }));
  res.json({ items });
});

app.post('/api/subscriptions', auth, async (req, res) => {
  const {
    name, category = 'Sonstiges', price = 0, billing_cycle = 'monatlich', renewal_date,
    notice_days = 14, provider_email = '', contract_id = '', notes = ''
  } = req.body || {};

  if (!name || !renewal_date) {
    return res.status(400).json({ error: 'Name und Verlängerungsdatum sind Pflicht.' });
  }

  const result = await run(
    `INSERT INTO subscriptions
    (user_id, name, category, price, billing_cycle, renewal_date, notice_days, provider_email, contract_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.userId, name, category, Number(price || 0), billing_cycle, renewal_date, Number(notice_days || 0), provider_email, contract_id, notes]
  );

  const item = await get('SELECT * FROM subscriptions WHERE id = ?', [result.id]);
  res.status(201).json({ item });
});

app.put('/api/subscriptions/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!existing) return res.status(404).json({ error: 'Abo nicht gefunden.' });

  const merged = { ...existing, ...req.body };
  await run(
    `UPDATE subscriptions SET
      name = ?, category = ?, price = ?, billing_cycle = ?, renewal_date = ?,
      notice_days = ?, provider_email = ?, contract_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?`,
    [
      merged.name,
      merged.category,
      Number(merged.price || 0),
      merged.billing_cycle,
      merged.renewal_date,
      Number(merged.notice_days || 0),
      merged.provider_email || '',
      merged.contract_id || '',
      merged.notes || '',
      id,
      req.user.userId
    ]
  );

  const item = await get('SELECT * FROM subscriptions WHERE id = ?', [id]);
  res.json({ item });
});

app.delete('/api/subscriptions/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const result = await run('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!result.changes) return res.status(404).json({ error: 'Abo nicht gefunden.' });
  res.json({ success: true });
});

app.get('/api/subscriptions/:id/template', auth, async (req, res) => {
  const id = Number(req.params.id);
  const item = await get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!item) return res.status(404).json({ error: 'Abo nicht gefunden.' });
  res.json({ template: buildTemplate(item) });
});

app.get('/api/stats', auth, async (req, res) => {
  const items = await all('SELECT * FROM subscriptions WHERE user_id = ?', [req.user.userId]);
  const monthly = items.reduce((sum, item) => sum + monthlyEquivalent(item), 0);
  const critical = items.filter((item) => getStatus(item) === 'kritisch').length;
  res.json({
    count: items.length,
    monthly,
    yearly: monthly * 12,
    critical
  });
});

app.post('/api/reminders/run-now', auth, async (req, res) => {
  try {
    const result = await sendDueReminders({ userId: req.user.userId, forceTodayOnly: true });
    res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    console.error('run-now Fehler:', error);
    res.status(500).json({ success: false, error: error.message || 'Unbekannter Fehler im Reminder-Lauf.' });
  }
});

app.post('/api/reminders/test-email', auth, async (req, res) => {
  try {
    const user = await get('SELECT id, name, email FROM users WHERE id = ?', [req.user.userId]);
    const info = await sendTestMailForUser(user);
    res.json({ success: true, message: `Testmail gesendet an ${info.to}.`, info });
  } catch (error) {
    console.error('Testmail-Fehler:', error);
    res.status(500).json({ success: false, error: error.message || 'Testmail fehlgeschlagen.' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  cron.schedule(CRON_SCHEDULE, () => {
    sendDueReminders().catch((error) => console.error(error));
  });

  app.listen(PORT, () => {
    console.log(`AboStop SaaS läuft auf ${APP_BASE_URL}`);
  });
}).catch((error) => {
  console.error('Start fehlgeschlagen:', error);
  process.exit(1);
});
