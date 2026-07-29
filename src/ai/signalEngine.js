'use strict';
const ind = require('./indicators');
const db = require('../db');
const logger = require('../utils/logger');

// Timeframe weights for multi-timeframe confluence
const TIMEFRAME_WEIGHT = { '1m': 0.6, '5m': 0.8, '15m': 1.2, '1h': 1.5 };

/**
 * Analyse a single timeframe's candles using all available indicators.
 * Returns a detailed result object or null if insufficient data.
 */
function analyzeTimeframe(candles) {
  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const n = closes.length;
  if (n < 50) return null;

  // ── Indicators ────────────────────────────────────────────────────────────
  const ema9    = ind.ema(closes, 9);
  const ema20   = ind.ema(closes, 20);
  const ema50   = ind.ema(closes, 50);
  const rsi14   = ind.rsi(closes, 14);
  const { macdLine, signalLine, histogram } = ind.macd(closes);
  const atr14   = ind.atr(highs, lows, closes, 14);
  const adx14   = ind.adx(highs, lows, closes, 14);
  const vwapArr = ind.vwap(highs, lows, closes, volumes);
  const bb      = ind.bollingerBands(closes, 20, 2);
  const sr      = ind.supportResistance(highs, lows, 30);
  const structure = ind.detectStructure(highs, lows, closes);

  const last  = n - 1;
  const price = closes[last];
  if (!price) return null;

  // ── Volume confirmation ───────────────────────────────────────────────────
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeConfirmed = volumes[last] > avgVol20 * 1.15;

  // ── ATR volatility filter – skip symbols that are too quiet ───────────────
  const atrVal = atr14[last];
  const atrPct = atrVal ? atrVal / price : 0;
  if (atrPct < 0.0005) return null; // skip flat / stale symbols

  // ── EMA trend score ───────────────────────────────────────────────────────
  let trendScore = 0;
  // EMA 9 > 20 > 50 = strong bull trend
  const e9  = ema9[last];
  const e20 = ema20[last];
  const e50 = ema50[last];
  if (e9 != null && e20 != null && e50 != null) {
    if (e9 > e20 && e20 > e50)       trendScore += 0.6;  // fully bullish
    else if (e9 < e20 && e20 < e50)  trendScore -= 0.6;  // fully bearish
    else if (e9 > e20)               trendScore += 0.3;
    else if (e9 < e20)               trendScore -= 0.3;
  }
  // Price vs VWAP
  const vwapVal = vwapArr[last];
  if (vwapVal) trendScore += price > vwapVal ? 0.2 : -0.2;

  // ── RSI momentum ─────────────────────────────────────────────────────────
  let momentumScore = 0;
  const rsiVal = rsi14[last];
  if (rsiVal != null) {
    if (rsiVal > 60)      momentumScore += 0.5;
    else if (rsiVal > 55) momentumScore += 0.3;
    else if (rsiVal < 40) momentumScore -= 0.5;
    else if (rsiVal < 45) momentumScore -= 0.3;
    // RSI divergence guard: don't enter overbought/oversold extremes
    if (rsiVal > 80)      momentumScore -= 0.4;  // likely reversal
    if (rsiVal < 20)      momentumScore += 0.4;  // likely reversal
  }
  // MACD
  const histVal = histogram[last];
  const macdVal = macdLine[last];
  const sigVal  = signalLine[last];
  if (histVal != null) momentumScore += histVal > 0 ? 0.3 : -0.3;
  if (macdVal != null && sigVal != null)
    momentumScore += macdVal > sigVal ? 0.2 : -0.2;

  // ── SMC / Smart Money Concept score ──────────────────────────────────────
  let smcScore = 0;
  const smcReasons = [];

  // BOS (Break of Structure)
  if (structure.bos === 'bullish') {
    smcScore += 0.4;
    smcReasons.push('Bullish BOS');
  } else if (structure.bos === 'bearish') {
    smcScore -= 0.4;
    smcReasons.push('Bearish BOS');
  }

  // CHOCH (Change of Character) – stronger signal
  if (structure.choch === 'bullish_choch') {
    smcScore += 0.5;
    smcReasons.push('Bullish CHOCH');
  } else if (structure.choch === 'bearish_choch') {
    smcScore -= 0.5;
    smcReasons.push('Bearish CHOCH');
  }

  // Liquidity Sweep – confirms intended direction after sweep
  if (structure.liquiditySweep) {
    // A sweep of lows is bullish (weak hands flushed), sweep of highs is bearish
    // detectStructure already sets this relative to recent swing points
    smcScore += structure.bos === 'bullish' ? 0.3 : -0.3;
    smcReasons.push('Liquidity Sweep');
  }

  // Fair Value Gap – price approaching unmitigated FVG in direction of trend
  if (structure.fvg && structure.fvg.length > 0) {
    const lastFvg = structure.fvg[structure.fvg.length - 1];
    if (lastFvg.type === 'bullish' && trendScore > 0) {
      smcScore += 0.25;
      smcReasons.push('Bullish FVG');
    } else if (lastFvg.type === 'bearish' && trendScore < 0) {
      smcScore += 0.25; // adds to bearish score
      smcReasons.push('Bearish FVG');
    }
  }

  // Order Blocks
  if (structure.orderBlocks && structure.orderBlocks.length > 0) {
    const lastOb = structure.orderBlocks[structure.orderBlocks.length - 1];
    if (lastOb.type === 'bullish' && trendScore > 0) {
      smcScore += 0.25;
      smcReasons.push('Bullish Order Block');
    } else if (lastOb.type === 'bearish' && trendScore < 0) {
      smcScore += 0.25;
      smcReasons.push('Bearish Order Block');
    }
  }

  // ── Bollinger Band context ────────────────────────────────────────────────
  const bbUpper = bb.upper[last];
  const bbLower = bb.lower[last];
  if (bbUpper && bbLower) {
    const bbWidth = (bbUpper - bbLower) / price;
    // Very narrow bands = low volatility, skip
    if (bbWidth < 0.005) return null;
  }

  // ── Combined confirmations ────────────────────────────────────────────────
  const trendConfirmed    = Math.abs(trendScore) >= 0.4;
  const momentumConfirmed = Math.abs(momentumScore) >= 0.3 &&
                            Math.sign(momentumScore) === Math.sign(trendScore || 1);
  const smcConfirmed      = Math.abs(smcScore) >= 0.4;

  // All three scores must agree on direction
  const bullish = (trendScore + momentumScore + smcScore) > 0;
  const direction = bullish ? 'long' : 'short';

  return {
    direction,
    trendScore,
    momentumScore,
    smcScore,
    smcReasons,
    trendConfirmed,
    momentumConfirmed,
    volumeConfirmed,
    smcConfirmed,
    price,
    atr: atrVal,
    support: sr.support,
    resistance: sr.resistance,
    structure,
    indicators: {
      ema9: e9, ema20: e20, ema50: e50,
      rsi: rsiVal,
      macd: macdVal, signal: sigVal, histogram: histVal,
      atr: atrVal, adx: adx14[last],
      vwap: vwapVal,
      bbUpper, bbLower,
    },
  };
}

/**
 * Combine results from multiple timeframes into a single signal decision.
 * Requires alignment on at least 3 of 4 timeframes and all 4 confirmations.
 */
function buildConfluence(timeframeResults, minRiskReward = 2) {
  const entries = Object.entries(timeframeResults).filter(([, v]) => v !== null);
  if (entries.length < 2) return null;  // need at least 2 TFs

  let longWeight = 0, shortWeight = 0, totalWeight = 0;
  let volVotes = 0, trendVotes = 0, momVotes = 0, smcVotes = 0;
  const allReasons = new Set();

  for (const [tf, res] of entries) {
    const w = TIMEFRAME_WEIGHT[tf] || 1;
    totalWeight += w;

    const score = res.trendScore + res.momentumScore + res.smcScore;
    if (res.direction === 'long') longWeight  += w * (0.5 + Math.min(1, Math.abs(score)) / 4);
    else                          shortWeight += w * (0.5 + Math.min(1, Math.abs(score)) / 4);

    if (res.volumeConfirmed)    volVotes   += w;
    if (res.trendConfirmed)     trendVotes += w;
    if (res.momentumConfirmed)  momVotes   += w;
    if (res.smcConfirmed)       smcVotes   += w;
    res.smcReasons.forEach((r) => allReasons.add(r));
  }

  const direction = longWeight >= shortWeight ? 'long' : 'short';
  const dominantWeight  = Math.max(longWeight, shortWeight);
  const alignment = dominantWeight / totalWeight;  // 0 – 1

  const volumeConfirmed   = volVotes   / totalWeight >= 0.5;
  const trendConfirmed    = trendVotes / totalWeight >= 0.5;
  const momentumConfirmed = momVotes   / totalWeight >= 0.5;
  const smcConfirmed      = smcVotes   / totalWeight >= 0.4;

  // Count how many timeframes agree with the dominant direction
  const agreeCount = entries.filter(([, r]) => r.direction === direction).length;
  const mtfAligned = agreeCount >= Math.ceil(entries.length * 0.75); // ≥75% TFs agree

  // Require all 4 confirmations + MTF alignment
  const allConfirmed = trendConfirmed && volumeConfirmed && momentumConfirmed && smcConfirmed;

  // ── Confidence score ──────────────────────────────────────────────────────
  // Alignment contributes 50%, individual confirmations contribute 50%
  const confirmPassed = [trendConfirmed, volumeConfirmed, momentumConfirmed, smcConfirmed]
    .filter(Boolean).length;
  let confidence = alignment * 50 + (confirmPassed / 4) * 40 + (mtfAligned ? 10 : 0);
  confidence = Math.round(Math.min(100, Math.max(0, confidence)));

  // ── Dynamic Risk:Reward ──────────────────────────────────────────────────
  // Use the highest-weight TF as primary for price levels
  const primary = entries.reduce((best, cur) =>
    (TIMEFRAME_WEIGHT[cur[0]] || 1) > (TIMEFRAME_WEIGHT[best[0]] || 1) ? cur : best
  )[1];

  const entryPrice = primary.price;
  const atr = primary.atr || entryPrice * 0.005;

  // SL: beyond ATR * 1.5 or last swing low/high
  let sl, tp;
  if (direction === 'long') {
    sl = Math.min(entryPrice - atr * 1.5, primary.support * 0.9995);
    tp = Math.max(entryPrice + atr * 3,   primary.resistance * 0.9998);
  } else {
    sl = Math.max(entryPrice + atr * 1.5, primary.resistance * 1.0005);
    tp = Math.min(entryPrice - atr * 3,   primary.support * 1.0002);
  }

  const slDist = Math.abs(entryPrice - sl);
  const tpDist = Math.abs(tp - entryPrice);
  const riskReward = slDist > 0 ? tpDist / slDist : 0;

  // Build human-readable reasons list
  const reasons = [];
  if (trendConfirmed)    reasons.push('EMA trend confirmed');
  if (volumeConfirmed)   reasons.push('Volume spike confirmed');
  if (momentumConfirmed) reasons.push('RSI/MACD momentum aligned');
  if (smcConfirmed)      reasons.push(...allReasons);
  if (mtfAligned)        reasons.push(`${agreeCount}/${entries.length} timeframes aligned`);

  return {
    direction,
    confidence,
    trendConfirmed,
    volumeConfirmed,
    momentumConfirmed,
    smcConfirmed,
    mtfAligned,
    allConfirmed,
    riskReward,
    entryPrice,
    stopLoss: sl,
    takeProfit: tp,
    primary,
    reasons,
  };
}

/**
 * Persist a qualifying signal to the database.
 */
async function persistSignal(symbol, timeframe, conf) {
  const info = await db.run(
    `INSERT INTO ai_signals
     (symbol, timeframe, direction, confidence,
      trend_confirmed, volume_confirmed, momentum_confirmed, smc_confirmed,
      risk_reward, entry_price, stop_loss, take_profit,
      indicators_json, reasons_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    [
      symbol, timeframe, conf.direction, conf.confidence,
      conf.trendConfirmed ? 1 : 0,
      conf.volumeConfirmed ? 1 : 0,
      conf.momentumConfirmed ? 1 : 0,
      conf.smcConfirmed ? 1 : 0,
      conf.riskReward,
      conf.entryPrice,
      conf.stopLoss,
      conf.takeProfit,
      JSON.stringify(conf.primary?.indicators || {}),
      JSON.stringify(conf.reasons || []),
    ]
  );
  return info.lastInsertRowid;
}

/**
 * Persist a rejected signal with reason (for transparency).
 */
async function persistRejectedSignal(symbol, timeframe, conf, reason) {
  await db.run(
    `INSERT INTO ai_signals
     (symbol, timeframe, direction, confidence,
      trend_confirmed, volume_confirmed, momentum_confirmed, smc_confirmed,
      risk_reward, entry_price, stop_loss, take_profit,
      indicators_json, reasons_json, reject_reason, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected')`,
    [
      symbol, timeframe, conf.direction || 'unknown', conf.confidence || 0,
      conf.trendConfirmed ? 1 : 0,
      conf.volumeConfirmed ? 1 : 0,
      conf.momentumConfirmed ? 1 : 0,
      conf.smcConfirmed ? 1 : 0,
      conf.riskReward || 0,
      conf.entryPrice || 0,
      conf.stopLoss || 0,
      conf.takeProfit || 0,
      JSON.stringify(conf.primary?.indicators || {}),
      JSON.stringify(conf.reasons || []),
      reason,
    ]
  );
}

module.exports = {
  analyzeTimeframe,
  buildConfluence,
  persistSignal,
  persistRejectedSignal,
  TIMEFRAME_WEIGHT,
};
