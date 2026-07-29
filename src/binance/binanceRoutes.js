'use strict';
const express    = require('express');
const db         = require('../db');
const cryptoUtil = require('../utils/crypto');
const logger     = require('../utils/logger');
const { requireAuth } = require('../auth/middleware');
const { BinanceClient, buildClient } = require('./binanceService');

const router = express.Router();
const VALID_TYPES = ['spot_testnet', 'spot_real', 'futures_testnet', 'futures_real'];

router.use(requireAuth);

// ─── Classify Binance errors for user-friendly frontend display ───────────────
function classifyBinanceError(err) {
  const code   = err.binanceCode;
  const status = err.status;
  const msg    = err.message || 'Unknown error';

  if (code === -2015 || code === -2014) return { type: 'invalid_api_key',  friendly: 'Invalid API Key. Check the key is correct and enabled.' };
  if (code === -1022)                   return { type: 'invalid_signature', friendly: 'Invalid API Secret. Signature verification failed.' };
  if (code === -2011 || code === -2010) return { type: 'insufficient_permissions', friendly: 'API Key is missing required permissions (Futures Trading or Spot Trading).' };
  if (code === -4046)                   return { type: 'futures_disabled',  friendly: 'Futures trading is not enabled on this account. Enable it in Binance settings.' };
  if (code === -3000)                   return { type: 'spot_disabled',     friendly: 'Spot trading is not available for this account type.' };
  if (code === -1021)                   return { type: 'timestamp_error',   friendly: 'Server clock is out of sync with Binance. Please try again.' };
  if (status === 429 || status === 418) return { type: 'rate_limited',      friendly: 'Binance rate limit hit. Wait a moment and try again.' };
  if (status === 503 || status === 502) return { type: 'binance_server_error', friendly: 'Binance server is temporarily unavailable. Try again in a few seconds.' };
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
    return { type: 'network_timeout', friendly: 'Network timeout reaching Binance. Check your server internet connection.' };
  }
  return { type: 'unknown_error', friendly: msg };
}

// ─── GET /api/binance/accounts ────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT id, account_type, label, is_active, is_verified, last_verified_at, created_at, api_key_enc FROM binance_accounts WHERE user_id = ?',
      [req.user.id]
    );
    const sanitized = rows.map((r) => ({
      ...r,
      api_key_masked: cryptoUtil.mask(cryptoUtil.decrypt(r.api_key_enc)),
      api_key_enc: undefined,
    }));
    res.json({ accounts: sanitized });
  } catch (e) {
    logger.error('binance', `GET /accounts: ${e.message}`);
    res.status(500).json({ error: 'Database error', detail: e.message, errorType: 'database_error' });
  }
});

// ─── POST /api/binance/accounts/connect ───────────────────────────────────────
router.post('/accounts/connect', async (req, res) => {
  const { accountType, apiKey, apiSecret, label } = req.body;
  if (!VALID_TYPES.includes(accountType))
    return res.status(400).json({ error: 'Invalid account type', errorType: 'validation_error' });
  if (!apiKey || apiKey.trim().length < 10)
    return res.status(400).json({ error: 'API Key is required', errorType: 'invalid_api_key' });
  if (!apiSecret || apiSecret.trim().length < 10)
    return res.status(400).json({ error: 'API Secret is required', errorType: 'invalid_signature' });

  const userLabel = label || accountType;
  logger.info('binance', `User ${req.user.id} attempting to connect ${accountType} account`);

  try {
    const client     = new BinanceClient(accountType, apiKey.trim(), apiSecret.trim());
    const validation = await client.validateKeys();

    logger.info('binance',
      `API validation for user ${req.user.id} (${accountType}): ${validation.ok ? 'SUCCESS' : 'FAILED – ' + validation.error}`
    );

    if (!validation.ok) {
      const classified = classifyBinanceError({ message: validation.error, binanceCode: validation.code, status: validation.httpStatus });
      return res.status(400).json({
        error:     classified.friendly,
        detail:    validation.error,
        hint:      validation.hint,
        errorType: classified.type,
        binanceCode: validation.code,
      });
    }

    // Check if this key is already saved
    const apiKeyEnc    = cryptoUtil.encrypt(apiKey.trim());
    const apiSecretEnc = cryptoUtil.encrypt(apiSecret.trim());

    const info = await db.run(
      `INSERT INTO binance_accounts
       (user_id, account_type, api_key_enc, api_secret_enc, label, is_active, is_verified, last_verified_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, strftime('%s','now'))`,
      [req.user.id, accountType, apiKeyEnc, apiSecretEnc, userLabel]
    );

    logger.info('binance', `User ${req.user.id} connected ${accountType} account #${info.lastInsertRowid}`);
    res.json({
      ok:        true,
      accountId: info.lastInsertRowid,
      message:   'API connected and verified successfully!',
    });
  } catch (e) {
    logger.error('binance', `connect failed for user ${req.user.id}: ${e.message}`);
    res.status(500).json({
      error:     'Unexpected server error during API validation',
      detail:    e.message,
      errorType: 'unknown_error',
    });
  }
});

// ─── DELETE /api/binance/accounts/:id ────────────────────────────────────────
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = await db.get(
      'SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!account) return res.status(404).json({ error: 'Account not found', errorType: 'not_found' });
    await db.run('DELETE FROM binance_accounts WHERE id = ?', [account.id]);
    logger.info('binance', `User ${req.user.id} removed account #${account.id}`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('binance', `DELETE account: ${e.message}`);
    res.status(500).json({ error: 'Database error', detail: e.message, errorType: 'database_error' });
  }
});

// ─── POST /api/binance/accounts/:id/revalidate ───────────────────────────────
router.post('/accounts/:id/revalidate', async (req, res) => {
  try {
    const account = await db.get(
      'SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!account) return res.status(404).json({ error: 'Account not found', errorType: 'not_found' });

    logger.info('binance', `Re-validating account #${account.id} (${account.account_type}) for user ${req.user.id}`);
    const client     = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
    const validation = await client.validateKeys();

    logger.info('binance',
      `Re-validation account #${account.id}: ${validation.ok ? 'SUCCESS' : 'FAILED – ' + validation.error}`
    );

    await db.run(
      "UPDATE binance_accounts SET is_verified = ?, last_verified_at = strftime('%s','now') WHERE id = ?",
      [validation.ok ? 1 : 0, account.id]
    );

    if (!validation.ok) {
      const classified = classifyBinanceError({ message: validation.error, binanceCode: validation.code, status: validation.httpStatus });
      return res.status(400).json({
        error:     classified.friendly,
        detail:    validation.error,
        hint:      validation.hint,
        errorType: classified.type,
      });
    }
    res.json({ ok: true, message: 'API key re-validated successfully.' });
  } catch (e) {
    logger.error('binance', `revalidate error: ${e.message}`);
    res.status(500).json({ error: 'Server error during re-validation', detail: e.message, errorType: 'unknown_error' });
  }
});

// ─── GET /api/binance/accounts/:id/snapshot ──────────────────────────────────
router.get('/accounts/:id/snapshot', async (req, res) => {
  try {
    const account = await db.get(
      'SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!account) return res.status(404).json({ error: 'Account not found', errorType: 'not_found' });

    const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
    const [accountInfo, openOrders, positions] = await Promise.all([
      client.accountInfo(),
      client.openOrders().catch(() => []),
      client.positionRisk().catch(() => []),
    ]);

    const trades  = await db.all(
      'SELECT * FROM trade_history WHERE account_id = ? ORDER BY closed_at DESC LIMIT 100',
      [account.id]
    );
    const wins    = trades.filter((t) => t.result === 'win').length;
    const winRate = trades.length ? (wins / trades.length) * 100 : 0;

    res.json({
      accountInfo: sanitizeAccountInfo(accountInfo, account.account_type),
      openOrders,
      positions,
      localTradeHistory: trades,
      winRate,
    });
  } catch (e) {
    const classified = classifyBinanceError(e);
    logger.error('binance', `snapshot error: ${e.message}`);
    res.status(400).json({
      error:     classified.friendly,
      detail:    e.message,
      errorType: classified.type,
    });
  }
});

function sanitizeAccountInfo(info, accountType) {
  if (accountType.startsWith('futures')) {
    return {
      totalWalletBalance:    info.totalWalletBalance,
      totalMarginBalance:    info.totalMarginBalance,
      availableBalance:      info.availableBalance,
      totalUnrealizedProfit: info.totalUnrealizedProfit,
    };
  }
  return {
    balances: (info.balances || []).filter(
      (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
    ),
  };
}

module.exports = router;
