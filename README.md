# Binance AI Trading Platform

A Node.js + Express + SQLite web platform for connecting Binance Spot/Futures
(Testnet or Real) accounts, viewing live account data, trading manually, and
optionally letting a rules-based AI engine auto-trade based on multi-timeframe
technical confluence.

## ⚠️ Read this before connecting a real account

- **Start on Testnet.** `spot_testnet` and `futures_testnet` use Binance's
  sandbox environment with fake funds. Get comfortable there first.
- **The "AI confidence score" is a transparent heuristic, not a proven edge.**
  It blends EMA/RSI/MACD/ATR/ADX/VWAP/Bollinger Band readings and a simplified
  approximation of Smart-Money-Concept structure (BOS/CHOCH/liquidity
  sweeps/fair value gaps/order blocks) across seven timeframes into a 0-100
  score. No combination of classic indicators has been shown to reliably hit
  a 95% real-world win rate — treat the confidence threshold as a
  configurable filter, not a guarantee. Backtest and paper-trade before
  risking real capital, and never risk more than you can afford to lose.
- **This is not financial advice**, and nothing in this codebase should be
  read as investment guidance.
- **Review the security section below** before exposing this to the public
  internet with real API keys attached.

## What's actually implemented

- Express server with a single SQLite database (`database.sqlite`), created
  and migrated automatically on first boot — no external DB required.
- JWT + bcrypt auth for users and a separate admin login, password reset flow,
  rate limiting, Helmet security headers, parameterized SQL everywhere.
- Binance REST client supporting all four modes (`spot_testnet`, `spot_real`,
  `futures_testnet`, `futures_real`) with HMAC-signed requests and detailed
  validation error messages.
- Binance WebSocket integration: a public market-data ticker stream plus
  per-account authenticated user-data streams (listenKey based), both with
  automatic reconnect/backoff.
- API keys are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY` in
  `.env`). Secret keys are **never** sent back to the browser or exposed in
  any API response — only a masked version of the API key is shown.
- A real technical-indicator library (EMA, SMA, RSI, MACD, ATR, ADX, VWAP,
  Bollinger Bands, support/resistance, and a heuristic structure detector)
  written in plain JS with no external TA dependency, verified against
  synthetic data during development.
- A multi-timeframe confluence engine that scores trend/momentum/volume
  agreement into a configurable confidence + risk:reward gate.
- An auto-trading loop that: monitors existing positions before opening new
  ones, prevents duplicate trades on the same symbol/account, applies
  stop-loss/take-profit/trailing-stop/break-even logic, and respects
  per-account risk settings (max risk %, max open positions, leverage).
  The loop is wrapped in try/catch per cycle so one bad tick never kills the
  process, and `ecosystem.config.js` gives PM2 auto-restart on crash.
- Full REST API for dashboard, markets, manual trading, signals, analytics,
  trade history, wallet, referrals, settings, notifications, support
  tickets, profile, and a complete admin panel (users, accounts, trades,
  signals, referrals, deposits/withdrawals, notifications, broadcast,
  support tickets, logs, AI settings, risk settings, site settings,
  maintenance mode, server status).
- A dark, glassmorphism, responsive frontend (vanilla HTML/CSS/JS, no build
  step) covering every page requested: landing, login, register,
  forgot/reset password, dashboard, markets, auto trading, manual trading,
  signals, analytics, trade history, wallet, referral, settings,
  notifications, support, profile, admin login, admin dashboard — with a
  shared sidebar/topbar on desktop and a bottom nav bar on mobile.

## What you should still do before going live with real money

- **Get a professional security review.** This includes reasonable defaults
  (JWT, bcrypt, AES-256-GCM, parameterized queries, rate limiting, Helmet)
  but a platform handling real exchange API keys and executing real trades
  deserves a dedicated audit, especially around key storage, session
  handling, and the admin panel's access controls.
- **Add CSRF protection to state-changing forms** if you expose this outside
  of a trusted single-page session flow (the scaffolding for this is in
  place — `cookie-parser` and cookie-based sessions are wired up — but a full
  CSRF token flow was intentionally kept minimal here to stay within scope).
- **Load-test the AI scanning loop** and tune `AI_SCAN_INTERVAL_MS` /
  `min_confidence` / `min_risk_reward` in the admin panel against Binance's
  rate limits before running many symbols/timeframes continuously.
- **Position sizing in `autoTrader.js` is simplified** (risk % of available
  USDT balance divided by ATR-based stop distance) — review and adapt it to
  your actual exchange rules (minQty, stepSize, minNotional, etc. from
  `exchangeInfo`) before trading Real accounts.
- **Add real email delivery** (SMTP settings are in `.env.example`) — without
  it, password reset links are only logged to the server console /
  returned directly in the API response in dev mode.

## Quick start (local)

```bash
npm install
cp .env.example .env
# Edit .env: set JWT_SECRET, COOKIE_SECRET, ENCRYPTION_KEY to long random
# strings, and change ADMIN_USERNAME / ADMIN_PASSWORD from the defaults.
npm start
```

The server starts on `http://localhost:3000` by default. `database.sqlite`
is created automatically on first run, along with the default admin account.

- App: http://localhost:3000
- Admin login: http://localhost:3000/admin-login.html
- Default admin credentials: `admin` / `admin123` (**change this immediately**
  by editing `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env` before first boot, or
  by changing the password directly in the `admins` table afterward)

## Getting Binance Testnet API keys (recommended first step)

- Spot Testnet: https://testnet.binance.vision
- Futures Testnet: https://testnet.binancefuture.com

Generate a key/secret pair there, then use "Settings" in the app to connect
a `Spot Testnet` or `Futures Testnet` account — no real funds are at risk.

## Environment variables

See `.env.example` for the full list. At minimum, set:

- `JWT_SECRET` — long random string, required for the server to boot
- `COOKIE_SECRET` — long random string
- `ENCRYPTION_KEY` — used to derive the AES-256 key for encrypting API secrets
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — used only on first boot to seed the
  default admin account

No database credentials are needed — SQLite is a local file.

## Running with PM2 (production)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 logs binance-ai-trading-platform
```

PM2 restarts the process automatically on crash (`autorestart: true`,
`max_restarts: 50`), which combined with the in-process reconnect logic in
`wsService.js` and the try/catch-wrapped scan loop in `autoTrader.js` is what
delivers the "restart automatically after crash / reconnect automatically"
requirement.

## Deploying to Railway

1. Push this project to a GitHub repo (or use the Railway CLI directly).
2. Create a new Railway project from the repo.
3. Add the environment variables from `.env.example` in the Railway project
   settings (Railway sets `PORT` automatically — you don't need to set it).
4. Railway will detect `railway.json` / `Procfile` and run `node server.js`.
5. **Important:** Railway's filesystem is ephemeral on redeploys unless you
   attach a persistent volume. Since all data lives in `database.sqlite`,
   mount a Railway volume at the project directory (or a subdirectory you
   point `src/db.js` at) if you need data to survive redeploys.

## Project structure

```
binance-ai-platform/
├── server.js                 # Entry point - wires everything together
├── package.json
├── railway.json
├── Procfile
├── ecosystem.config.js        # PM2 config
├── .env.example
├── database.sqlite            # created automatically on first run
├── src/
│   ├── db.js                  # SQLite schema + seed data
│   ├── auth/                  # JWT auth routes + middleware
│   ├── binance/                # Binance REST client, WS manager, account routes
│   ├── ai/                    # Indicators, signal engine, auto-trading loop
│   ├── routes/                # dashboard/markets/trading/signals/analytics/...
│   └── utils/                 # encryption, logging
└── public/                    # Static frontend (HTML/CSS/vanilla JS)
    ├── css/style.css
    └── js/                    # api.js, auth.js, admin-auth.js, layout.js
```

(Route/service code lives under `src/` and pages under `public/` rather than
a fully flat layout, since a maintainable multi-page app of this size needs
at least that much structure — everything still lives in this single project
root with no separate repos or extra top-level folders.)

## Security notes

- Passwords hashed with bcrypt (cost factor 12).
- Sessions via JWT, `httpOnly` cookies + optional Authorization header.
- Binance API secrets encrypted with AES-256-GCM before being written to
  SQLite; decrypted only in-memory for the duration of a single API/WS call.
- All SQL uses `better-sqlite3` parameterized statements — no string
  concatenation, so standard SQL injection vectors are closed.
- Rate limiting on all `/api/*` routes, with a tighter limit on auth
  endpoints (login/register/admin-login/forgot-password).
- `helmet` sets standard security headers.
- Frontend renders user-supplied text via `textContent`-safe templates where
  practical; review any field before extending it if you plan to accept
  richer HTML input from users.

## License

MIT — use, modify, and deploy as you see fit. No warranty of any kind is
provided, especially regarding trading outcomes.
