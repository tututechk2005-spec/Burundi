'use strict';
const db        = require('../db');
const logger    = require('../utils/logger');
const telegram  = require('../utils/telegram');
const state     = require('../state');
const scanner   = require('../binance/scanner');
const { BinanceClient, buildClient } = require('../binance/binanceService');
const { analyzeTimeframe, buildConfluence, persistSignal, persistRejectedSignal } = require('./signalEngine');

const CORE_TIMEFRAMES = ['1m', '5m', '15m', '1h'];

// Per-symbol cooldown to prevent duplicate signals / trades
// Map<symbol, { lastSignalAt: number, lastTradeAt: number }>
const symbolCooldowns = new Map();
const SIGNAL_COOLDOWN_MS = 5  * 60 * 1000;  // 5 min between signals per symbol
const TRADE_COOLDOWN_MS  = 15 * 60 * 1000;  // 15 min between trades per symbol

function canSendSignal(symbol) {
  const c = symbolCooldowns.get(symbol);
  if (!c) return true;
  return Date.now() - c.lastSignalAt > SIGNAL_COOLDOWN_MS;
}

function canOpenTrade(symbol) {
  const c = symbolCooldowns.get(symbol);
  if (!c) return true;
  return Date.now() - c.lastTradeAt > TRADE_COOLDOWN_MS;
}

function markSignalSent(symbol) {
  const c = symbolCooldowns.get(symbol) || { lastSignalAt: 0, lastTradeAt: 0 };
  c.lastSignalAt = Date.now();
  symbolCooldowns.set(symbol, c);
}

function markTradeSent(symbol) {
  const c = symbolCooldowns.get(symbol) || { lastSignalAt: 0, lastTradeAt: 0 };
  c.lastTradeAt = Date.now();
  symbolCooldowns.set(symbol, c);
}

function toCandles(klines) {
  return klines.map((k) => ({
    openTime: k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

class AutoTrader {
  constructor(broadcastFn) {
    this.broadcast = broadcastFn || (() => {});
    this.running   = false;
    this.timer     = null;
    this._publicClient = new BinanceClient('futures_real', null, null);
  }

  start() {
    if (this.running) return;
    this.running = true;
    state.scanner.running = true;
    this._loop();
    logger.info('autotrader', 'AI auto-trading engine started');
    if (!telegram.isConfigured()) {
      logger.warn('autotrader', 'Telegram is not configured – set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    }
  }

  stop() {
    this.running = false;
    state.scanner.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    logger.info('autotrader', 'AI auto-trading engine stopped');
  }

  _loop() {
    if (!this.running) return;
    db.get('SELECT * FROM ai_settings WHERE id = 1').then((settings) => {
      const interval = settings?.scan_interval_ms || 15000;
      state.scanner.enabled = !!(settings?.enabled);
      this.scanOnce()
        .catch((e) => logger.error('autotrader', `Scan cycle error: ${e.message}`))
        .finally(() => {
          if (this.running) {
            this.timer = setTimeout(() => this._loop(), interval);
          }
        });
    }).catch(() => {
      if (this.running) this.timer = setTimeout(() => this._loop(), 15000);
    });
  }

  async scanOnce() {
    const settings = await db.get('SELECT * FROM ai_settings WHERE id = 1');
    if (!settings || !settings.enabled) {
      state.scanner.enabled = false;
      return;
    }
    state.scanner.enabled = true;

    // Get timeframes from settings (default to 4 core TFs)
    const timeframes = (settings.timeframes || '1m,5m,15m,1h')
      .split(',').map((s) => s.trim()).filter((s) => CORE_TIMEFRAMES.includes(s));
    if (timeframes.length < 2) {
      logger.warn('autotrader', 'Need at least 2 valid timeframes for MTF analysis');
      return;
    }

    const minConfidence = settings.min_confidence || 85;
    const minRR         = settings.min_risk_reward || 2;

    // Get symbol list
    let symbols;
    const symbolSetting = (settings.symbols || 'ALL_FUTURES_USDT').trim();
    if (symbolSetting === 'ALL_FUTURES_USDT') {
      symbols = await scanner.getSymbols();
    } else {
      symbols = symbolSetting.split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (!symbols.length) {
      logger.warn('autotrader', 'No symbols to scan – symbol list is empty');
      return;
    }

    state.scanner.pairsTotal     = symbols.length;
    state.scanner.pairsScanned   = 0;
    state.scanner.lastScanStartedAt = new Date().toISOString();
    state.scanner.cycleCount++;

    logger.info('scanner', `Scan cycle #${state.scanner.cycleCount} started: ${symbols.length} pairs`);
    const cycleStart = Date.now();

    for (const symbol of symbols) {
      if (!this.running) break;
      state.scanner.currentSymbol = symbol;
      try {
        await this._analyzeSymbol(symbol, timeframes, minConfidence, minRR);
      } catch (e) {
        logger.error('scanner', `${symbol}: ${e.message}`);
        state.scanner.errors++;
      }
      state.scanner.pairsScanned++;
    }

    state.scanner.lastScanFinishedAt  = new Date().toISOString();
    state.scanner.lastCycleDurationMs = Date.now() - cycleStart;
    state.scanner.currentSymbol       = null;
    logger.info('scanner', `Cycle #${state.scanner.cycleCount} done in ${state.scanner.lastCycleDurationMs}ms (${state.scanner.pairsScanned} pairs)`);

    // Process open positions for all active accounts
    const accounts = await db.all(
      `SELECT ba.* FROM binance_accounts ba
       JOIN users u ON u.id = ba.user_id
       WHERE ba.is_active = 1 AND ba.is_verified = 1`
    );
    for (const account of accounts) {
      try {
        await this._processAccount(account, symbols, minConfidence, minRR);
      } catch (e) {
        logger.error('autotrader', `Account ${account.id} error: ${e.message}`);
      }
    }
  }

  async _analyzeSymbol(symbol, timeframes, minConfidence, minRR) {
    const tfResults = {};
    for (const tf of timeframes) {
      try {
        // Use Futures REST API for USDT perp data
        const kl = await this._publicClient.klines(symbol, tf, 200);
        tfResults[tf] = analyzeTimeframe(toCandles(kl));
      } catch (e) {
        // Symbol may be temporarily unavailable – skip this TF
        tfResults[tf] = null;
      }
    }

    const confluence = buildConfluence(tfResults, minRR);
    if (!confluence) return null;

    const qualifies = confluence.confidence >= minConfidence &&
                      confluence.riskReward >= minRR &&
                      confluence.trendConfirmed &&
                      confluence.volumeConfirmed &&
                      confluence.momentumConfirmed &&
                      confluence.smcConfirmed &&
                      confluence.mtfAligned;

    // Always log rejected signals with reason
    if (!qualifies) {
      const reasons = [];
      if (confluence.confidence < minConfidence)
        reasons.push(`Confidence ${confluence.confidence}% < ${minConfidence}%`);
      if (confluence.riskReward < minRR)
        reasons.push(`R:R ${confluence.riskReward.toFixed(2)} < ${minRR}`);
      if (!confluence.trendConfirmed)    reasons.push('Trend not confirmed');
      if (!confluence.volumeConfirmed)   reasons.push('Volume not confirmed');
      if (!confluence.momentumConfirmed) reasons.push('Momentum not confirmed');
      if (!confluence.smcConfirmed)      reasons.push('SMC not confirmed');
      if (!confluence.mtfAligned)        reasons.push('MTF not aligned');

      const reason = reasons.join('; ');
      logger.info('scanner', `REJECTED ${symbol}: ${reason}`);
      await persistRejectedSignal(symbol, 'multi', confluence, reason);
      return null;
    }

    // Duplicate check: did we already send this signal recently?
    if (!canSendSignal(symbol)) {
      logger.info('scanner', `COOLDOWN ${symbol}: signal cooldown active`);
      return null;
    }

    // DB-level duplicate check: no new signal for this symbol in the last 5 min
    const recentSignal = await db.get(
      `SELECT id FROM ai_signals
       WHERE symbol = ? AND status != 'rejected'
         AND created_at > strftime('%s','now') - 300
       LIMIT 1`,
      [symbol]
    );
    if (recentSignal) {
      logger.info('scanner', `DUPLICATE ${symbol}: recent signal exists (id=${recentSignal.id})`);
      return null;
    }

    const signalId = await persistSignal(symbol, 'multi', confluence);
    markSignalSent(symbol);

    // Send Telegram (non-blocking)
    if (!await db.get('SELECT id FROM ai_signals WHERE id = ? AND telegram_sent = 1', [signalId])) {
      telegram.sendSignal({
        symbol,
        direction:   confluence.direction,
        confidence:  confluence.confidence,
        riskReward:  confluence.riskReward,
        sl:          confluence.stopLoss,
        tp:          confluence.takeProfit,
        price:       confluence.entryPrice,
        reasons:     confluence.reasons,
      }).then((sent) => {
        if (sent) db.run('UPDATE ai_signals SET telegram_sent = 1 WHERE id = ?', [signalId]);
      });
    }

    this.broadcast({
      type:       'signal',
      symbol,
      direction:  confluence.direction,
      confidence: confluence.confidence,
      riskReward: confluence.riskReward,
      qualifies:  true,
      signalId,
    });

    logger.info('scanner', `SIGNAL ${symbol} ${confluence.direction.toUpperCase()} conf=${confluence.confidence}% RR=${confluence.riskReward.toFixed(2)}`);
    return confluence;
  }

  async _processAccount(account, symbols, minConfidence, minRR) {
    const risk = await db.get('SELECT * FROM risk_settings WHERE id = 1');
    const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);

    // Manage existing positions first
    const openPositions = await db.all(
      "SELECT * FROM positions WHERE account_id = ? AND status = 'open'",
      [account.id]
    );
    for (const pos of openPositions) {
      await this._managePosition(client, account, pos, risk);
    }

    // Check position limit
    const openCount = await db.get(
      "SELECT COUNT(*) as c FROM positions WHERE account_id = ? AND status = 'open'",
      [account.id]
    );
    if ((openCount?.c || 0) >= (risk?.max_open_positions || 3)) return;

    // Look for qualifying signals to trade
    for (const symbol of symbols) {
      if ((openCount?.c || 0) >= (risk?.max_open_positions || 3)) break;

      // No duplicate open position for same symbol
      const existing = await db.get(
        "SELECT id FROM positions WHERE account_id = ? AND symbol = ? AND status = 'open'",
        [account.id, symbol]
      );
      if (existing) continue;

      // Trade cooldown
      if (!canOpenTrade(symbol)) continue;

      // Get the most recent qualifying signal (not yet executed)
      const signal = await db.get(
        `SELECT * FROM ai_signals
         WHERE symbol = ? AND status = 'new' AND confidence >= ? AND risk_reward >= ?
           AND trend_confirmed = 1 AND volume_confirmed = 1 AND momentum_confirmed = 1 AND smc_confirmed = 1
         ORDER BY created_at DESC LIMIT 1`,
        [symbol, minConfidence, minRR]
      );
      if (!signal) continue;

      // Signal must be fresh (< 5 min old)
      const signalAge = Math.floor(Date.now() / 1000) - signal.created_at;
      if (signalAge > 300) {
        await db.run("UPDATE ai_signals SET status = 'expired' WHERE id = ?", [signal.id]);
        continue;
      }

      await this._executeTrade(client, account, signal, risk);
    }
  }

  async _executeTrade(client, account, signal, risk) {
    try {
      const side = signal.direction === 'long' ? 'BUY' : 'SELL';
      const price = signal.entry_price ||
                    JSON.parse(signal.indicators_json || '{}').vwap ||
                    JSON.parse(signal.indicators_json || '{}').ema20;
      if (!price) {
        logger.warn('autotrader', `${signal.symbol}: no price for trade, skipping`);
        return;
      }

      const balances    = await client.balances().catch(() => []);
      const usdtBalance = Array.isArray(balances)
        ? balances.find((b) => b.asset === 'USDT')
        : (balances?.assets || []).find((b) => b.asset === 'USDT');

      const availableUsdt = parseFloat(
        usdtBalance?.availableBalance || usdtBalance?.free || 0
      );
      if (availableUsdt < 10) {
        logger.warn('autotrader', `${signal.symbol}: insufficient USDT balance (${availableUsdt})`);
        return;
      }

      const riskAmount  = availableUsdt * ((risk?.max_risk_per_trade_pct || 1) / 100);
      const atr         = JSON.parse(signal.indicators_json || '{}').atr || price * 0.005;
      const stopDist    = Math.abs(price - (signal.stop_loss || price * (1 - 0.015)));
      let quantity      = stopDist > 0 ? riskAmount / stopDist : 0;
      if (!quantity || !isFinite(quantity) || quantity <= 0) return;

      // Use signal-computed SL/TP or fall back to risk settings
      const slPct = (risk?.stop_loss_pct || 1.5) / 100;
      const tpPct = (risk?.take_profit_pct || 3)  / 100;
      const sl    = signal.stop_loss  || (side === 'BUY' ? price * (1 - slPct) : price * (1 + slPct));
      const tp    = signal.take_profit || (side === 'BUY' ? price * (1 + tpPct) : price * (1 - tpPct));

      // Validate RR is acceptable
      const slDist  = Math.abs(price - sl);
      const tpDist  = Math.abs(tp - price);
      const rr      = slDist > 0 ? tpDist / slDist : 0;
      if (rr < (risk?.min_risk_reward || 2) * 0.8) {
        logger.info('autotrader', `${signal.symbol}: poor RR ${rr.toFixed(2)}, skipping`);
        await db.run("UPDATE ai_signals SET status = 'rejected', reject_reason = ? WHERE id = ?",
          [`Poor RR: ${rr.toFixed(2)}`, signal.id]);
        return;
      }

      const order = await client.placeOrder({
        symbol:   signal.symbol,
        side,
        type:     'MARKET',
        quantity: quantity.toFixed(6),
      });

      await db.run(
        `INSERT INTO orders
         (user_id, account_id, binance_order_id, symbol, side, type, price, quantity, status, source)
         VALUES (?, ?, ?, ?, ?, 'MARKET', ?, ?, 'filled', 'auto')`,
        [account.user_id, account.id, order.orderId?.toString(), signal.symbol, side, price, quantity]
      );

      const posInfo = await db.run(
        `INSERT INTO positions
         (user_id, account_id, symbol, side, entry_price, quantity, leverage, stop_loss, take_profit, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [account.user_id, account.id, signal.symbol, signal.direction,
         price, quantity, risk?.default_leverage || 1, sl, tp]
      );

      await db.run("UPDATE ai_signals SET status = 'executed' WHERE id = ?", [signal.id]);
      markTradeSent(signal.symbol);

      await db.run(
        `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'trade')`,
        [account.user_id, 'Auto trade opened',
         `${side} ${signal.symbol} conf=${signal.confidence}% RR=1:${rr.toFixed(1)}`]
      );

      logger.info('autotrader',
        `Opened ${side} ${signal.symbol} qty=${quantity.toFixed(4)} price=${price} SL=${sl.toFixed(4)} TP=${tp.toFixed(4)}`);

      // Telegram – non-blocking
      telegram.sendTradeOpen({
        symbol:     signal.symbol,
        direction:  signal.direction,
        price,
        quantity,
        sl,
        tp,
        confidence: signal.confidence,
      }).then((sent) => {
        if (sent) db.run('UPDATE positions SET telegram_sent = 1 WHERE id = ?', [posInfo.lastInsertRowid]);
      });

    } catch (e) {
      logger.error('autotrader', `Trade execution failed ${signal.symbol}: ${e.message}`);
    }
  }

  async _managePosition(client, account, pos, risk) {
    try {
      const ticker = await this._publicClient.ticker24hr(pos.symbol).catch(() => null);
      const currentPrice = ticker ? parseFloat(ticker.lastPrice || ticker.price || 0) : null;
      if (!currentPrice) return;

      const isLong = pos.side === 'long';

      // Check if SL or TP is hit
      let shouldClose = false;
      let closeReason = '';
      if (isLong  && pos.stop_loss   && currentPrice <= pos.stop_loss)   { shouldClose = true; closeReason = 'Stop Loss'; }
      if (!isLong && pos.stop_loss   && currentPrice >= pos.stop_loss)   { shouldClose = true; closeReason = 'Stop Loss'; }
      if (isLong  && pos.take_profit && currentPrice >= pos.take_profit) { shouldClose = true; closeReason = 'Take Profit'; }
      if (!isLong && pos.take_profit && currentPrice <= pos.take_profit) { shouldClose = true; closeReason = 'Take Profit'; }

      // Move SL to break-even
      const breakEvenTrigger = (risk?.break_even_trigger_pct || 1) / 100;
      const movedPct = isLong
        ? (currentPrice - pos.entry_price) / pos.entry_price
        : (pos.entry_price - currentPrice) / pos.entry_price;

      if (movedPct >= breakEvenTrigger && pos.stop_loss !== pos.entry_price) {
        await db.run('UPDATE positions SET stop_loss = ? WHERE id = ?', [pos.entry_price, pos.id]);
      }

      // Trailing stop
      const trailPct = (risk?.trailing_stop_pct || 1) / 100;
      if (movedPct > trailPct) {
        const newStop = isLong
          ? currentPrice * (1 - trailPct)
          : currentPrice * (1 + trailPct);
        if ((isLong && newStop > (pos.stop_loss || 0)) ||
            (!isLong && newStop < (pos.stop_loss || Infinity))) {
          await db.run('UPDATE positions SET stop_loss = ? WHERE id = ?', [newStop, pos.id]);
        }
      }

      if (shouldClose) {
        const side   = isLong ? 'SELL' : 'BUY';
        const pnl    = isLong
          ? (currentPrice - pos.entry_price) * pos.quantity
          : (pos.entry_price - currentPrice) * pos.quantity;
        const result = pnl >= 0 ? 'win' : 'loss';

        await client.placeOrder({
          symbol:   pos.symbol,
          side,
          type:     'MARKET',
          quantity: pos.quantity.toFixed(6),
        }).catch((e) => {
          logger.error('autotrader', `Close order failed ${pos.symbol}: ${e.message}`);
        });

        await db.run(
          "UPDATE positions SET status='closed', pnl=?, closed_at=strftime('%s','now') WHERE id=?",
          [pnl, pos.id]
        );
        await db.run(
          `INSERT INTO trade_history
           (user_id, account_id, symbol, side, entry_price, exit_price, quantity, pnl, result, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`,
          [account.user_id, account.id, pos.symbol, pos.side,
           pos.entry_price, currentPrice, pos.quantity, pnl, result]
        );
        await db.run(
          `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'trade')`,
          [account.user_id, `Position closed (${closeReason})`,
           `${pos.symbol} PNL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT`]
        );

        logger.info('autotrader',
          `Closed ${pos.symbol} (${closeReason}) PNL=${pnl.toFixed(4)} result=${result}`);

        // Telegram – non-blocking
        telegram.sendTradeClose({
          symbol:     pos.symbol,
          direction:  pos.side,
          entryPrice: pos.entry_price,
          exitPrice:  currentPrice,
          pnl,
          result,
        });
      }
    } catch (e) {
      logger.error('autotrader', `managePosition failed pos#${pos.id}: ${e.message}`);
    }
  }
}

module.exports = AutoTrader;
