const crypto = require('crypto');
const axios = require('axios');
const cryptoUtil = require('../utils/crypto');
const logger = require('../utils/logger');

// Base URLs for each of the 4 supported account modes
const BASE_URLS = {
  spot_real: 'https://api.binance.com',
  spot_testnet: 'https://testnet.binance.vision',
  futures_real: 'https://fapi.binance.com',
  futures_testnet: 'https://testnet.binancefuture.com',
};

function isFutures(accountType) {
  return accountType === 'futures_real' || accountType === 'futures_testnet';
}

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Thin wrapper around the Binance REST API. Every call takes the decrypted
 * apiKey/apiSecret pair for the account so we never keep long-lived clients
 * with credentials in memory longer than a single request.
 */
class BinanceClient {
  constructor(accountType, apiKey, apiSecret) {
    if (!BASE_URLS[accountType]) throw new Error(`Unknown account type: ${accountType}`);
    this.accountType = accountType;
    this.baseUrl = BASE_URLS[accountType];
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.futures = isFutures(accountType);
  }

  async request(method, path, params = {}, signed = false) {
    const query = new URLSearchParams(params);
    if (signed) {
      query.set('timestamp', Date.now().toString());
      query.set('recvWindow', '10000');
      const signature = sign(query.toString(), this.apiSecret);
      query.set('signature', signature);
    }
    const url = `${this.baseUrl}${path}${query.toString() ? '?' + query.toString() : ''}`;
    try {
      const res = await axios({
        method,
        url,
        headers: this.apiKey ? { 'X-MBX-APIKEY': this.apiKey } : {},
        timeout: 15000,
      });
      return res.data;
    } catch (err) {
      const detail = err.response?.data || { msg: err.message };
      const e = new Error(detail.msg || 'Binance API request failed');
      e.binanceCode = detail.code;
      e.status = err.response?.status;
      throw e;
    }
  }

  // ---- Public/market data --------------------------------------------------
  ping() {
    return this.request('GET', this.futures ? '/fapi/v1/ping' : '/api/v3/ping');
  }

  serverTime() {
    return this.request('GET', this.futures ? '/fapi/v1/time' : '/api/v3/time');
  }

  klines(symbol, interval, limit = 200) {
    const path = this.futures ? '/fapi/v1/klines' : '/api/v3/klines';
    return this.request('GET', path, { symbol, interval, limit });
  }

  ticker24hr(symbol) {
    const path = this.futures ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr';
    return this.request('GET', path, symbol ? { symbol } : {});
  }

  exchangeInfo() {
    const path = this.futures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    return this.request('GET', path);
  }

  // ---- Account / private ----------------------------------------------------
  accountInfo() {
    const path = this.futures ? '/fapi/v2/account' : '/api/v3/account';
    return this.request('GET', path, {}, true);
  }

  balances() {
    if (this.futures) return this.request('GET', '/fapi/v2/balance', {}, true);
    return this.accountInfo().then((a) => a.balances);
  }

  openOrders(symbol) {
    const path = this.futures ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
    return this.request('GET', path, symbol ? { symbol } : {}, true);
  }

  positionRisk(symbol) {
    if (!this.futures) return Promise.resolve([]);
    return this.request('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {}, true);
  }

  myTrades(symbol, limit = 50) {
    const path = this.futures ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
    return this.request('GET', path, { symbol, limit }, true);
  }

  // ---- Trading ---------------------------------------------------------------
  placeOrder(params) {
    const path = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.request('POST', path, params, true);
  }

  cancelOrder(symbol, orderId) {
    const path = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.request('DELETE', path, { symbol, orderId }, true);
  }

  changeLeverage(symbol, leverage) {
    if (!this.futures) return Promise.resolve(null);
    return this.request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
  }

  // ---- Validation --------------------------------------------------------
  async validateKeys() {
    try {
      await this.ping();
      const account = await this.accountInfo();
      return { ok: true, account };
    } catch (err) {
      logger.error('binance', `Key validation failed for ${this.accountType}: ${err.message}`);
      return {
        ok: false,
        error: err.message,
        code: err.binanceCode,
        httpStatus: err.status,
        hint: hintForError(err),
      };
    }
  }
}

function hintForError(err) {
  if (err.status === 401 || err.binanceCode === -2015) {
    return 'Invalid API key, IP restriction, or missing permissions. Check that the key is enabled for this account type (spot/futures) and that your server IP is whitelisted if you set an IP restriction on the key.';
  }
  if (err.binanceCode === -1021) {
    return 'Timestamp out of sync - server clock drift. Try again; recvWindow is already set to 10s.';
  }
  if (err.status === 418 || err.status === 429) {
    return 'Rate limited by Binance. Wait before retrying.';
  }
  return 'Verify the API key/secret, account type (spot/futures, testnet/real), and required permissions (read + trade).';
}

function buildClient(accountType, encApiKey, encApiSecret) {
  const apiKey = cryptoUtil.decrypt(encApiKey);
  const apiSecret = cryptoUtil.decrypt(encApiSecret);
  return new BinanceClient(accountType, apiKey, apiSecret);
}

module.exports = { BinanceClient, buildClient, BASE_URLS, isFutures };
