'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
  : path.join(__dirname, '..', 'database.sqlite');

// ---------------------------------------------------------------------------
// Open / create the SQLite database file
// ---------------------------------------------------------------------------
const _db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('[db] Failed to open database:', err.message); process.exit(1); }
  console.log('[db] SQLite database opened at', DB_PATH);
});

// Enable WAL mode and foreign keys right after open
_db.serialize(() => {
  _db.run('PRAGMA journal_mode = WAL');
  _db.run('PRAGMA foreign_keys = ON');
});

// ---------------------------------------------------------------------------
// Promise-based helpers
// ---------------------------------------------------------------------------

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastInsertRowid: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    _db.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'active',
  reset_token TEXT,
  reset_token_expires INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS binance_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_type TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  api_secret_enc TEXT NOT NULL,
  label TEXT,
  is_active INTEGER DEFAULT 1,
  is_verified INTEGER DEFAULT 0,
  last_verified_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS wallet_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  wallet_balance REAL DEFAULT 0,
  available_balance REAL DEFAULT 0,
  margin_balance REAL DEFAULT 0,
  unrealized_pnl REAL DEFAULT 0,
  realized_pnl REAL DEFAULT 0,
  total_profit REAL DEFAULT 0,
  total_loss REAL DEFAULT 0,
  roi REAL DEFAULT 0,
  win_rate REAL DEFAULT 0,
  loss_rate REAL DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  today_profit REAL DEFAULT 0,
  weekly_profit REAL DEFAULT 0,
  monthly_profit REAL DEFAULT 0,
  current_leverage REAL DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL,
  quantity REAL,
  leverage REAL DEFAULT 1,
  stop_loss REAL,
  take_profit REAL,
  trailing_stop REAL,
  status TEXT DEFAULT 'open',
  pnl REAL DEFAULT 0,
  telegram_sent INTEGER DEFAULT 0,
  opened_at INTEGER DEFAULT (strftime('%s','now')),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  binance_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL,
  quantity REAL,
  status TEXT DEFAULT 'open',
  source TEXT DEFAULT 'manual',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS trade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  pnl REAL,
  result TEXT,
  source TEXT DEFAULT 'manual',
  closed_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS ai_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  trend_confirmed INTEGER DEFAULT 0,
  volume_confirmed INTEGER DEFAULT 0,
  momentum_confirmed INTEGER DEFAULT 0,
  smc_confirmed INTEGER DEFAULT 0,
  risk_reward REAL,
  entry_price REAL,
  stop_loss REAL,
  take_profit REAL,
  indicators_json TEXT,
  reasons_json TEXT,
  reject_reason TEXT,
  status TEXT DEFAULT 'new',
  telegram_sent INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  referred_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'active',
  earnings REAL DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  method TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  destination TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  is_read INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  reply TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_confidence REAL DEFAULT 85,
  min_risk_reward REAL DEFAULT 2,
  scan_interval_ms INTEGER DEFAULT 15000,
  enabled INTEGER DEFAULT 1,
  timeframes TEXT DEFAULT '1m,5m,15m,1h',
  symbols TEXT DEFAULT 'ALL_FUTURES_USDT'
);

CREATE TABLE IF NOT EXISTS risk_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_risk_per_trade_pct REAL DEFAULT 1,
  max_open_positions INTEGER DEFAULT 3,
  default_leverage REAL DEFAULT 5,
  max_leverage REAL DEFAULT 20,
  stop_loss_pct REAL DEFAULT 1.5,
  take_profit_pct REAL DEFAULT 3,
  trailing_stop_pct REAL DEFAULT 1,
  break_even_trigger_pct REAL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT DEFAULT 'info',
  scope TEXT,
  message TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS ai_learning_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT,
  timeframe TEXT,
  signal_id INTEGER,
  outcome TEXT,
  pnl REAL,
  features_json TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  expires_at INTEGER
);
`;

// ---------------------------------------------------------------------------
// Safe ALTER TABLE helper – adds column if it doesn't exist
// ---------------------------------------------------------------------------
async function addColumnIfMissing(table, column, definition) {
  try {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // SQLite throws "duplicate column name" when column already exists – ignore
    if (!e.message.includes('duplicate column name')) {
      console.warn(`[db] ALTER TABLE ${table} ADD COLUMN ${column}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialise schema + seed defaults, then export a ready promise
// ---------------------------------------------------------------------------
async function initDb() {
  await exec(SCHEMA);

  // Migrations – add new columns to existing tables without recreating them
  await addColumnIfMissing('ai_signals', 'smc_confirmed',  'INTEGER DEFAULT 0');
  await addColumnIfMissing('ai_signals', 'entry_price',    'REAL');
  await addColumnIfMissing('ai_signals', 'stop_loss',      'REAL');
  await addColumnIfMissing('ai_signals', 'take_profit',    'REAL');
  await addColumnIfMissing('ai_signals', 'reasons_json',   'TEXT');
  await addColumnIfMissing('ai_signals', 'reject_reason',  'TEXT');
  await addColumnIfMissing('ai_signals', 'telegram_sent',  'INTEGER DEFAULT 0');
  await addColumnIfMissing('positions',  'telegram_sent',  'INTEGER DEFAULT 0');

  // Default admin – only if no admin exists
  const adminCount = await get('SELECT COUNT(*) as c FROM admins');
  if (!adminCount || adminCount.c === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 12);
    await run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
    console.log('[db] Default admin created -> username:', username);
  }

  // AI settings row – default min_confidence = 85
  const aiRow = await get('SELECT id FROM ai_settings WHERE id = 1');
  if (!aiRow) {
    await run(
      "INSERT INTO ai_settings (id, min_confidence, timeframes, symbols) VALUES (1, ?, ?, ?)",
      [
        Number(process.env.AI_MIN_CONFIDENCE || 85),
        '1m,5m,15m,1h',
        'ALL_FUTURES_USDT',
      ]
    );
  } else {
    // If existing row has old 95% default, lower it to 85
    await run(
      'UPDATE ai_settings SET min_confidence = ? WHERE id = 1 AND min_confidence >= 95',
      [85]
    );
    // Ensure timeframes include the 4 key MTF timeframes
    await run(
      "UPDATE ai_settings SET timeframes = '1m,5m,15m,1h' WHERE id = 1 AND timeframes = '1m,3m,5m,15m,30m,1h,4h'"
    );
    // Switch to ALL_FUTURES_USDT if still on old hardcoded list
    await run(
      "UPDATE ai_settings SET symbols = 'ALL_FUTURES_USDT' WHERE id = 1 AND symbols IN ('BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT','')"
    );
  }

  // Risk settings row
  const riskRow = await get('SELECT id FROM risk_settings WHERE id = 1');
  if (!riskRow) {
    await run('INSERT INTO risk_settings (id) VALUES (1)');
  }

  // Site settings defaults
  const siteDefaults = {
    site_name: 'Binance AI Trading Platform',
    maintenance_mode: 'off',
    registration_open: 'on',
  };
  for (const [k, v] of Object.entries(siteDefaults)) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }

  console.log('[db] Schema ready.');
}

// Export the promise so server.js can await it before starting
const ready = initDb().catch((err) => {
  console.error('[db] Initialisation failed:', err);
  process.exit(1);
});

module.exports = { run, get, all, exec, ready };
