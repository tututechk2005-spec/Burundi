'use strict';
const express = require('express');
const db      = require('../db');
const state   = require('../state');
const { requireAuth } = require('../auth/middleware');
const scanner = require('../binance/scanner');

const router = express.Router();
router.use(requireAuth);

router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.id;

    const [
      accounts,
      openPositions,
      openOrders,
      trades,
      aiSettings,
      notifRow,
    ] = await Promise.all([
      db.all('SELECT id, account_type, label, is_verified FROM binance_accounts WHERE user_id = ?', [userId]),
      db.all("SELECT * FROM positions WHERE user_id = ? AND status = 'open'", [userId]),
      db.all("SELECT * FROM orders WHERE user_id = ? AND status = 'open'", [userId]),
      db.all('SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at DESC LIMIT 200', [userId]),
      db.get('SELECT * FROM ai_settings WHERE id = 1'),
      db.get('SELECT COUNT(*) as c FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND is_read = 0', [userId]),
    ]);

    const totalTrades  = trades.length;
    const wins         = trades.filter((t) => t.result === 'win').length;
    const losses       = trades.filter((t) => t.result === 'loss').length;
    const totalProfit  = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const totalLoss    = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const winRate      = totalTrades ? (wins / totalTrades) * 100 : 0;
    const lossRate     = totalTrades ? (losses / totalTrades) * 100 : 0;
    const totalPnl     = totalProfit - totalLoss;

    const now = Math.floor(Date.now() / 1000);
    const sumSince = (since) =>
      trades.filter((t) => t.closed_at >= since).reduce((a, t) => a + (t.pnl || 0), 0);

    const latestSignals = await db.all(
      "SELECT * FROM ai_signals WHERE status != 'rejected' ORDER BY created_at DESC LIMIT 10"
    );

    // Scanner state (from in-memory state module)
    const scannerInfo = {
      running:           state.scanner.running,
      enabled:           state.scanner.enabled,
      pairsTotal:        state.scanner.pairsTotal || scanner.count,
      pairsScanned:      state.scanner.pairsScanned,
      cycleCount:        state.scanner.cycleCount,
      lastScanStartedAt: state.scanner.lastScanStartedAt,
      lastScanFinishedAt:state.scanner.lastScanFinishedAt,
      lastCycleDurationMs: state.scanner.lastCycleDurationMs,
      symbolListRefreshed: scanner.lastRefreshed,
    };

    // Recent logs for dashboard panels (last 50 of each category)
    const [apiLogs, scannerLogs, errorLogs] = await Promise.all([
      db.all("SELECT * FROM logs WHERE scope IN ('binance','auth') ORDER BY created_at DESC LIMIT 50"),
      db.all("SELECT * FROM logs WHERE scope IN ('scanner','autotrader') ORDER BY created_at DESC LIMIT 50"),
      db.all("SELECT * FROM logs WHERE level = 'error' ORDER BY created_at DESC LIMIT 50"),
    ]);

    res.json({
      accounts,
      openPositions,
      openOrders,
      totalTrades,
      wins,
      losses,
      winRate,
      lossRate,
      totalProfit,
      totalLoss,
      totalPnl,
      roi: totalLoss > 0 ? ((totalProfit - totalLoss) / totalLoss) * 100 : (totalProfit > 0 ? 100 : 0),
      todayProfit:   sumSince(now - 86400),
      weeklyProfit:  sumSince(now - 7 * 86400),
      monthlyProfit: sumSince(now - 30 * 86400),
      latestSignals,
      scanner:       scannerInfo,
      aiEnabled:     !!aiSettings?.enabled,
      unreadNotifications: notifRow?.c || 0,
      serverStatus:  'online',
      botStatus:     aiSettings?.enabled ? 'running' : 'stopped',
      logs: { api: apiLogs, scanner: scannerLogs, errors: errorLogs },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, errorType: 'database_error' });
  }
});

module.exports = router;
