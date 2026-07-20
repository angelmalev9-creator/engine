import cors from "cors";
import express from "express";
import {
  assertConfig,
  config,
  DEFAULT_SETTINGS,
  mergeSettings,
} from "./config.js";
import {
  copytradeTick,
  refreshWatchers,
} from "./copytrade.js";
import { kolscanLeaderboard } from "./kolscan.js";
import {
  getMarketChart,
  getMarketFeed,
  getMarketToken,
  marketDiscoveryTick,
  marketRefreshTick,
  marketSecurityTick,
  marketStatus,
} from "./market.js";
import { rpcStatus } from "./rpc.js";
import {
  getLatestScan,
  refreshMarketData,
  sniperTick,
} from "./sniper.js";
import { q, sb } from "./supabase.js";
import {
  closePositionFor,
  evaluateToken,
  manageAllPositions,
  marketSnapshot,
  openPositionFor,
  paperSummary,
  scamCheck,
} from "./trading.js";
import {
  balanceSol,
  ensureUserWallet,
  tokenBalances,
} from "./wallets.js";

assertConfig();

const app = express();

app.use(express.json({ limit: "256kb" }));
app.use(cors({ origin: config.corsOrigin }));

const authCache = new Map();

async function auth(req, res, next) {
  const token = (req.headers.authorization || "")
    .replace(/^Bearer /, "");

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  const hit = authCache.get(token);

  if (hit && Date.now() - hit.ts < 60_000) {
    req.user = hit.user;
    return next();
  }

  const { data, error } = await sb.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  authCache.set(token, {
    ts: Date.now(),
    user: data.user,
  });

  req.user = data.user;
  next();
}

function validMint(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value || "");
}

// ── Per-user state ────────────────────────────────────────────────────────
app.get("/api/me/state", auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const profile = await q.profile(uid);
    const publicKey = await ensureUserWallet(uid);

    const [balance, tokens] = await Promise.all([
      balanceSol(publicKey).catch(() => null),
      tokenBalances(publicKey).catch(() => []),
    ]);

    const settings = mergeSettings(await q.settings(uid));
    const positions = await q.userPositions(uid, 200);
    const mode = settings.tradingMode === "live" ? "live" : "paper";
    const liveTrading =
      mode === "live" &&
      config.liveTrading &&
      profile.plan === "pro";

    const modePositions = mode === "paper"
      ? positions.filter(position => !position.buy_signature)
      : positions.filter(position => Boolean(position.buy_signature));

    const closed = modePositions.filter(
      position =>
        position.status === "closed" &&
        position.pnl_pct !== null
    );

    const openStatus = mode === "paper" ? "alert" : "open";
    const paper = paperSummary(positions, settings);

    res.json({
      ts: Date.now(),
      plan: profile.plan,
      mode,
      liveTrading,
      wallet: {
        publicKey,
        balanceSol: balance,
        funded: (balance || 0) > 0.001,
        tokens,
      },
      settings,
      defaults: DEFAULT_SETTINGS,
      positions: modePositions,
      paper,
      stats: {
        closedTrades: closed.length,
        winRate: closed.length
          ? (
              closed.filter(position => position.pnl_pct > 0).length /
              closed.length
            ) * 100
          : null,
        realizedPnlSol: closed.reduce(
          (sum, position) =>
            sum + Number(position.pnl_sol || 0),
          0
        ),
        openPositions: modePositions.filter(
          position => position.status === openStatus
        ).length,
      },
      transactions: await q.userTxs(uid),
      copyEvents: await q.userCopyEvents(uid),
      traders: await q.traders(uid),
      signals: await q.recentSignals(30),
      scan: getLatestScan(),
      market: marketStatus(),
      rpc: rpcStatus(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/me/settings", auth, async (req, res) => {
  try {
    res.json(
      await q.saveSettings(req.user.id, req.body || {})
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual PAPER entry. It uses the same strategy gate and a live Jupiter quote.
app.post("/api/me/paper/buy", auth, async (req, res) => {
  try {
    const mint = String(req.body?.mint || "").trim();

    if (!validMint(mint)) {
      return res.status(400).json({ error: "Invalid Solana token mint" });
    }

    const uid = req.user.id;
    const profile = await q.profile(uid);
    const settings = mergeSettings(await q.settings(uid));

    if (settings.tradingMode !== "paper") {
      return res.status(409).json({
        error: "Switch Execution mode to PAPER before creating a demo trade",
      });
    }

    const evaluation = await evaluateToken(mint, settings.entry);

    if (!evaluation.tradeReady) {
      return res.status(422).json({
        error: "Token is blocked by the current strategy",
        checks: evaluation.checks,
        security: evaluation.security?.checks || null,
      });
    }

    const requestedSize = Number(req.body?.sizeSol);
    const sizeSol = Number.isFinite(requestedSize) && requestedSize > 0
      ? requestedSize
      : Number(settings.buySizeSol);

    const position = await openPositionFor({
      userId: uid,
      profile,
      settings,
      mint,
      snapshot: evaluation.snapshot,
      source: "manual-paper",
      sizeSol,
    });

    if (!position) {
      return res.status(409).json({
        error: "Max positions reached or token already open",
      });
    }

    res.json({ ok: true, position });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/me/paper/sell/:id", auth, async (req, res) => {
  try {
    const positions = await q.userPositions(req.user.id, 200);
    const position = positions.find(
      item => String(item.id) === String(req.params.id)
    );

    if (!position) {
      return res.status(404).json({ error: "Position not found" });
    }

    if (position.status !== "alert" || position.buy_signature) {
      return res.status(409).json({
        error: "Only an open PAPER position can be closed here",
      });
    }

    const snapshot = await marketSnapshot(position.mint).catch(() => null);

    await closePositionFor(
      position,
      "manual PAPER exit",
      snapshot
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Tracked KOLs ──────────────────────────────────────────────────────────
app.post("/api/me/traders", auth, async (req, res) => {
  const { address, name } = req.body || {};

  if (!validMint(address)) {
    return res.status(400).json({ error: "Invalid Solana address" });
  }

  try {
    res.json(
      await q.upsertTrader({
        user_id: req.user.id,
        address,
        name: name || null,
        active: true,
      })
    );

    await refreshWatchers();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/me/traders/:address", auth, async (req, res) => {
  try {
    await sb
      .from("tracked_traders")
      .update({ active: false })
      .eq("user_id", req.user.id)
      .eq("address", req.params.address);

    await refreshWatchers();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/kolscan/leaderboard", auth, async (_req, res) => {
  try {
    res.json(await kolscanLeaderboard());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Dense scanner feed + chart ────────────────────────────────────────────
app.get("/api/market/feed", auth, async (_req, res) => {
  res.json(getMarketFeed());
});

app.get("/api/market/token/:mint", auth, async (req, res) => {
  try {
    if (!validMint(req.params.mint)) {
      return res.status(400).json({ error: "Invalid Solana token mint" });
    }

    res.json(await getMarketToken(req.params.mint));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/market/chart/:pair", auth, async (req, res) => {
  try {
    res.json(
      await getMarketChart(req.params.pair, {
        timeframe: req.query.timeframe,
        aggregate: req.query.aggregate,
        limit: req.query.limit,
      })
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/scamcheck/:mint", auth, async (req, res) => {
  try {
    res.json(await scamCheck(req.params.mint));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (_req, res) => {
  const scan = getLatestScan();

  res.json({
    ok: true,
    ts: Date.now(),
    scannerMarketUpdatedAt: scan.marketUpdatedAt,
    scannerVisibleTokens: scan.candidates.length,
    denseMarket: marketStatus(),
  });
});

// ── Engine loops ──────────────────────────────────────────────────────────
const safe = (name, fn) => () =>
  fn().catch(error =>
    console.error(`${name}: ${error.message}`)
  );

refreshWatchers().catch(() => {});

// Strategy scanner.
setInterval(safe("sniper discovery", sniperTick), 30_000);
setInterval(safe("sniper refresh", refreshMarketData), 5_000);

// DEX-style dense market feed.
setInterval(safe("market discovery", marketDiscoveryTick), 60_000);
setInterval(safe("market feed refresh", marketRefreshTick), 5_000);
setInterval(safe("market security", marketSecurityTick), 10_000);

// Positions and KOL copytrading.
setInterval(safe("exits", manageAllPositions), 10_000);
setInterval(safe("copytrade", copytradeTick), 4_000);
setInterval(safe("watchers", refreshWatchers), 60_000);

safe("market discovery", marketDiscoveryTick)();
safe("sniper discovery", sniperTick)();

app.listen(config.port, () => {
  console.log(`Emerald Gate V3 engine on :${config.port}`);
  console.log("Dense market rows refresh every 5 seconds");
  console.log("KOL wallets poll every 4 seconds");
  console.log(
    `Global live-money switch: ${
      config.liveTrading ? "ENABLED" : "DISABLED"
    }`
  );
});
