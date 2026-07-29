'use strict';
const express    = require('express');
const db         = require('../db');
const cryptoUtil = require('../utils/crypto');
const state      = require('../state');
const scanner    = require('../binance/scanner');
const telegram   = require('../utils/telegram');
const { requireAdmin } = require('../auth/middleware');

const router = express.Router();
router.use(requireAdmin);

router.get('/stats', async (req, res) => {
  try {
    const [users, accounts, trades, totalPnl, openPositions, signals, referrals, pendingWithdrawals, openTickets] =
      await Promise.all([
        db.get('SELECT COUNT(*) as c FROM users'),
        db.get('SELECT COUNT(*) as c FROM binance_accounts'),
        db.get('SELECT COUNT(*) as c FROM trade_history'),
        db.get('SELECT COALESCE(SUM(pnl),0) as s FROM trade_history'),
        db.get("SELECT COUNT(*) as c FROM positions WHERE status='open'"),
        db.get('SELECT COUNT(*) as c FROM ai_signals'),
        db.get('SELECT COUNT(*) as c FROM referrals'),
        db.get("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'"),
        db.get("SELECT COUNT(*) as c FROM support_tickets WHERE status='open'"),
      ]);
    res.json({
      users: users.c, accounts: accounts.c, trades: trades.c, totalPnl: totalPnl.s,
      openPositions: openPositions.c, signals: signals.c, referrals: referrals.c,
      pendingWithdrawals: pendingWithdrawals.c, openTickets: openTickets.c,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/users', async (req, res) => {
  try {
    const rows = await db.all('SELECT id, name, email, status, role, referral_code, created_at FROM users ORDER BY created_at DESC');
    res.json({ users: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users/:id/suspend', async (req, res) => {
  try {
    await db.run("UPDATE users SET status='suspended' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users/:id/activate', async (req, res) => {
  try {
    await db.run("UPDATE users SET status='active' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/binance-accounts', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT ba.id, ba.account_type, ba.label, ba.is_active, ba.is_verified, ba.created_at,
              u.name, u.email, ba.api_key_enc
       FROM binance_accounts ba JOIN users u ON u.id=ba.user_id ORDER BY ba.created_at DESC`
    );
    const sanitized = rows.map((r) => ({
      ...r,
      api_key_masked: cryptoUtil.mask(cryptoUtil.decrypt(r.api_key_enc)),
      api_key_enc: undefined,
    }));
    res.json({ accounts: sanitized });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/trades', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT th.*, u.name, u.email FROM trade_history th
       JOIN users u ON u.id=th.user_id ORDER BY th.closed_at DESC LIMIT 200`
    );
    res.json({ trades: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/signals', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT 200');
    res.json({ signals: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/referrals', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT r.*, ur.name as referrer_name, ud.name as referred_name
       FROM referrals r
       JOIN users ur ON ur.id=r.referrer_id
       JOIN users ud ON ud.id=r.referred_id
       ORDER BY r.created_at DESC`
    );
    res.json({ referrals: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/deposits', async (req, res) => {
  try {
    const rows = await db.all('SELECT d.*, u.name, u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC');
    res.json({ deposits: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deposits/:id/approve', async (req, res) => {
  try {
    await db.run("UPDATE deposits SET status='approved' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const rows = await db.all('SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.created_at DESC');
    res.json({ withdrawals: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/withdrawals/:id/approve', async (req, res) => {
  try {
    await db.run("UPDATE withdrawals SET status='approved' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  try {
    await db.run("UPDATE withdrawals SET status='rejected' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/notifications', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200');
    res.json({ notifications: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/broadcast', async (req, res) => {
  const { title, message, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  try {
    await db.run('INSERT INTO notifications (user_id, title, message, type) VALUES (NULL, ?, ?, ?)', [title, message, type || 'announcement']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  try {
    const { scope, level, limit = 300 } = req.query;
    let sql = 'SELECT * FROM logs WHERE 1=1';
    const params = [];
    if (scope) { sql += ' AND scope = ?'; params.push(scope); }
    if (level) { sql += ' AND level = ?'; params.push(level); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Number(limit));
    const rows = await db.all(sql, params);
    res.json({ logs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/support-tickets', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT st.*, u.name, u.email FROM support_tickets st
       JOIN users u ON u.id=st.user_id ORDER BY st.created_at DESC`
    );
    res.json({ tickets: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/support-tickets/:id/reply', async (req, res) => {
  const { reply } = req.body;
  try {
    await db.run("UPDATE support_tickets SET reply=?, status='closed' WHERE id=?", [reply, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/ai-settings', async (req, res) => {
  try {
    const settings = await db.get('SELECT * FROM ai_settings WHERE id=1');
    res.json({ settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ai-settings', async (req, res) => {
  const { min_confidence, min_risk_reward, scan_interval_ms, enabled, timeframes, symbols } = req.body;
  try {
    await db.run(
      `UPDATE ai_settings SET
        min_confidence   = COALESCE(?, min_confidence),
        min_risk_reward  = COALESCE(?, min_risk_reward),
        scan_interval_ms = COALESCE(?, scan_interval_ms),
        enabled          = COALESCE(?, enabled),
        timeframes       = COALESCE(?, timeframes),
        symbols          = COALESCE(?, symbols)
       WHERE id=1`,
      [min_confidence, min_risk_reward, scan_interval_ms,
       enabled != null ? (enabled ? 1 : 0) : null, timeframes, symbols]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/risk-settings', async (req, res) => {
  try {
    const settings = await db.get('SELECT * FROM risk_settings WHERE id=1');
    res.json({ settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/risk-settings', async (req, res) => {
  const f = req.body;
  try {
    await db.run(
      `UPDATE risk_settings SET
        max_risk_per_trade_pct  = COALESCE(?, max_risk_per_trade_pct),
        max_open_positions      = COALESCE(?, max_open_positions),
        default_leverage        = COALESCE(?, default_leverage),
        max_leverage            = COALESCE(?, max_leverage),
        stop_loss_pct           = COALESCE(?, stop_loss_pct),
        take_profit_pct         = COALESCE(?, take_profit_pct),
        trailing_stop_pct       = COALESCE(?, trailing_stop_pct),
        break_even_trigger_pct  = COALESCE(?, break_even_trigger_pct)
       WHERE id=1`,
      [f.max_risk_per_trade_pct, f.max_open_positions, f.default_leverage, f.max_leverage,
       f.stop_loss_pct, f.take_profit_pct, f.trailing_stop_pct, f.break_even_trigger_pct]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/site-settings', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM settings');
    const obj = {};
    rows.forEach((r) => { obj[r.key] = r.value; });
    res.json({ settings: obj });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/site-settings', async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body || {})) {
      await db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [k, String(v)]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/maintenance-mode', async (req, res) => {
  const { enabled } = req.body;
  try {
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ['maintenance_mode', enabled ? 'on' : 'off']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/server-status', (req, res) => {
  res.json({
    status:        'online',
    uptimeSeconds: Math.floor(process.uptime()),
    memory:        process.memoryUsage(),
    nodeVersion:   process.version,
    scanner:       state.scanner,
    telegram: {
      configured:   telegram.isConfigured(),
      messagesSent: state.telegram.messagesSent,
    },
    symbolsAvailable: scanner.count,
    symbolsLastRefreshed: scanner.lastRefreshed,
  });
});

router.get('/scanner-status', (req, res) => {
  res.json({
    ...state.scanner,
    symbolsAvailable: scanner.count,
    symbolsLastRefreshed: scanner.lastRefreshed,
  });
});

module.exports = router;
