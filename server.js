const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'worktimer.db');

let db;

function sqlRows(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]]))
  );
}

function run(sql, params = []) { db.run(sql, params); }
function all(sql, params = []) { return sqlRows(db.exec(sql, params)); }
function get(sql, params = []) { return all(sql, params)[0] ?? null; }
function lastId() { return get('SELECT last_insert_rowid() AS id').id; }
function saveDb() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT (datetime('now'))
  )`);
  run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    started_at DATETIME NOT NULL,
    ended_at DATETIME,
    duration_seconds INTEGER,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);
  saveDb();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/clients', (req, res) => {
  res.json(all('SELECT * FROM clients ORDER BY name ASC'));
});

app.post('/api/clients', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    run('INSERT INTO clients (name) VALUES (?)', [name.trim()]);
    const id = lastId();
    saveDb();
    res.json({ id, name: name.trim() });
  } catch (e) {
    res.status(409).json({ error: 'Client already exists' });
  }
});

app.delete('/api/clients/:id', (req, res) => {
  run('DELETE FROM sessions WHERE client_id = ?', [req.params.id]);
  run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ ok: true });
});

app.post('/api/sessions/start', (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const started_at = new Date().toISOString();
  run('INSERT INTO sessions (client_id, started_at) VALUES (?, ?)', [client_id, started_at]);
  const id = lastId();
  saveDb();
  res.json({ id, started_at });
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const session = get('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const ended_at = new Date().toISOString();
  const duration_seconds = Math.round(
    (new Date(ended_at) - new Date(session.started_at)) / 1000
  );
  run('UPDATE sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?',
    [ended_at, duration_seconds, req.params.id]);
  saveDb();
  res.json({ id: session.id, duration_seconds, ended_at });
});

app.delete('/api/sessions/:id', (req, res) => {
  run('DELETE FROM sessions WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ ok: true });
});

app.get('/api/log', (req, res) => {
  res.json(all(`
    SELECT s.id, c.name AS client, s.started_at, s.ended_at, s.duration_seconds
    FROM sessions s JOIN clients c ON s.client_id = c.id
    ORDER BY s.started_at DESC LIMIT 200
  `));
});

app.get('/api/totals', (req, res) => {
  res.json(all(`
    SELECT c.name AS client,
           SUM(s.duration_seconds) AS total_seconds,
           COUNT(*) AS session_count
    FROM sessions s JOIN clients c ON s.client_id = c.id
    WHERE s.duration_seconds IS NOT NULL
    GROUP BY c.id ORDER BY total_seconds DESC
  `));
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Work Timer running → http://localhost:${PORT}`);
  });
});
