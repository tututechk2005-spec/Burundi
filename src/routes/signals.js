'use strict';
const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

// All signals (excluding rejected ones by default)
router.get('/', async (req, res) => {
  try {
    const includeRejected = req.query.rejected === '1';
    const sql = includeRejected
      ? 'SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT 200'
      : "SELECT * FROM ai_signals WHERE status != 'rejected' ORDER BY created_at DESC LIMIT 100";
    const signals = await db.all(sql);
    res.json({ signals });
  } catch (e) {
    res.status(500).json({ error: e.message, errorType: 'database_error' });
  }
});

// Rejected signals only (for transparency / debugging)
router.get('/rejected', async (req, res) => {
  try {
    const signals = await db.all(
      "SELECT * FROM ai_signals WHERE status = 'rejected' ORDER BY created_at DESC LIMIT 200"
    );
    res.json({ signals });
  } catch (e) {
    res.status(500).json({ error: e.message, errorType: 'database_error' });
  }
});

// Scanner stats summary
router.get('/stats', async (req, res) => {
  try {
    const [total, executed, rejected, newSigs] = await Promise.all([
      db.get('SELECT COUNT(*) as c FROM ai_signals'),
      db.get("SELECT COUNT(*) as c FROM ai_signals WHERE status = 'executed'"),
      db.get("SELECT COUNT(*) as c FROM ai_signals WHERE status = 'rejected'"),
      db.get("SELECT COUNT(*) as c FROM ai_signals WHERE status = 'new'"),
    ]);
    res.json({
      total:    total.c,
      executed: executed.c,
      rejected: rejected.c,
      pending:  newSigs.c,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, errorType: 'database_error' });
  }
});

module.exports = router;
