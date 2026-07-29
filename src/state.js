'use strict';
// Shared mutable runtime state – written by AutoTrader, read by dashboard/admin routes.
// No DB persistence; reset on process restart.

module.exports = {
  scanner: {
    running: false,
    enabled: false,
    pairsTotal: 0,
    pairsScanned: 0,
    currentSymbol: null,
    cycleCount: 0,
    lastScanStartedAt: null,
    lastScanFinishedAt: null,
    lastCycleDurationMs: null,
    errors: 0,
  },
  telegram: {
    configured: false,
    messagesSent: 0,
  },
};
