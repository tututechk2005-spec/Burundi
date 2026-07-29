'use strict';
const axios = require('axios');
const logger = require('../utils/logger');

const FUTURES_API = 'https://fapi.binance.com';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Statuses that mean the symbol is live and tradable
const TRADABLE_STATUSES = new Set(['TRADING']);

class FuturesScanner {
  constructor() {
    this._symbols = [];
    this._lastRefresh = 0;
    this._refreshing = false;
  }

  /**
   * Returns the cached list of tradable USDT perpetual symbols.
   * Auto-refreshes if the cache is older than REFRESH_INTERVAL_MS.
   */
  async getSymbols() {
    const now = Date.now();
    if (this._symbols.length > 0 && now - this._lastRefresh < REFRESH_INTERVAL_MS) {
      return this._symbols;
    }
    return this.refresh();
  }

  /**
   * Force-refresh the symbol list from Binance Futures exchangeInfo.
   */
  async refresh() {
    if (this._refreshing) {
      // Another call is already refreshing – wait briefly and return cached
      await new Promise((r) => setTimeout(r, 2000));
      return this._symbols;
    }
    this._refreshing = true;
    try {
      const res = await axios.get(`${FUTURES_API}/fapi/v1/exchangeInfo`, { timeout: 15000 });
      const symbols = (res.data.symbols || [])
        .filter((s) =>
          s.quoteAsset === 'USDT' &&
          s.contractType === 'PERPETUAL' &&
          TRADABLE_STATUSES.has(s.status)
        )
        .map((s) => s.symbol);

      this._symbols = symbols;
      this._lastRefresh = Date.now();
      logger.info('scanner', `Symbol list refreshed: ${symbols.length} tradable USDT perpetuals`);
      return symbols;
    } catch (err) {
      logger.error('scanner', `Failed to refresh symbol list: ${err.message}`);
      // Return whatever we had before (may be empty on first boot)
      return this._symbols;
    } finally {
      this._refreshing = false;
    }
  }

  get count() {
    return this._symbols.length;
  }

  get lastRefreshed() {
    return this._lastRefresh ? new Date(this._lastRefresh).toISOString() : null;
  }
}

// Singleton
module.exports = new FuturesScanner();
