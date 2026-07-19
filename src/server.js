import cors from "cors";
import express from "express";
import { assertConfig, config, DEFAULT_SETTINGS, mergeSettings } from "./config.js";
import { copytradeTick, refreshWatchers } from "./copytrade.js";
import { kolscanLeaderboard } from "./kolscan.js";
import { rpcStatus } from "./rpc.js";
import { getLatestScan, sniperTick } from "./sniper.js";
import { q, sb } from "./supabase.js";
import { manageAllPositions, scamCheck } from "./trading.js";
import { balanceSol, ensureUserWallet, tokenBalances } from "./wallets.js";

assertConfig();
const app = express();
app.use(express.json());
app.use(cors({ origin: config.corsOrigin }));

// ── Auth: verify Supabase JWT from the Vercel-hosted frontend ──────────────
const authCache = new Map(); // token -> { ts, user }
async function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "Missing token" });
  const hit = authCache.get(token);
  if (hit && Date.now() - hit.ts < 60_000) { req.user = hit.user; return next(); }
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid token" });
  authCache.set(token, { ts: Date.now(), user: data.user });
  req.user = data.user;
  next();
}

// ── Per-user state (dashboard polls this every 5s) ─────────────────────────
app.get("/api/me/state", auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const profile = await q.profile(uid);
    const publicKey = await ensureUserWallet(uid);
    const [bal, tokens] = await Promise.all([
      balanceSol(publicKey).catch(() => null),
      tokenBalances(publicKey).catch(() => []),
    ]);
    const positions = await q.userPositions(uid);
    const closed = positions.filter(p => p.status === "closed" && p.pnl_pct !== null);
    res.json({
      ts: Date.now(),
      plan: profile.plan,
      liveTrading: config.liveTrading && profile.plan === "pro",
      wallet: { publicKey, balanceSol: bal, funded: (bal || 0) > 0.001, tokens },
      settings: mergeSettings(await q.settings(uid)),
      defaults: DEFAULT_SETTINGS,
      positions,
      stats: {
        closedTrades: closed.length,
        winRate: closed.length ? (closed.filter(p => p.pnl_pct > 0).length / closed.length) * 100 : null,
        realizedPnlSol: closed.reduce((s, p) => s + Number(p.pnl_sol || 0), 0),
        openPositions: positions.filter(p => p.status === "open").length,
      },
      transactions: await q.userTxs(uid),
      copyEvents: await q.userCopyEvents(uid),
      traders: await q.traders(uid),
      signals: await q.recentSignals(30),
      scan: getLatestScan(),
      rpc: rpcStatus(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/me/settings", auth, async (req, res) => {
  try { res.json(await q.saveSettings(req.user.id, req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/me/traders", auth, async (req, res) => {
  const { address, name } = req.body || {};
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || "")) return res.status(400).json({ error: "Invalid Solana address" });
  try {
    res.json(await q.upsertTrader({ user_id: req.user.id, address, name: name || null, active: true }));
    await refreshWatchers();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/me/traders/:address", auth, async (req, res) => {
  try {
    await sb.from("tracked_traders").update({ active: false })
      .eq("user_id", req.user.id).eq("address", req.params.address);
    await refreshWatchers();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/kolscan/leaderboard", auth, async (_req, res) => {
  res.json(await kolscanLeaderboard());
});

app.get("/api/scamcheck/:mint", auth, async (req, res) => {
  try { res.json(await scamCheck(req.params.mint)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Engine loops ───────────────────────────────────────────────────────────
const safe = (name, fn) => () => fn().catch(e => console.error(`${name}: ${e.message}`));
refreshWatchers().catch(() => {});
setInterval(safe("sniper", sniperTick), 30_000);
setInterval(safe("exits", manageAllPositions), 10_000);
setInterval(safe("copytrade", copytradeTick), 4_000);
setInterval(safe("watchers", refreshWatchers), 60_000);
safe("sniper", sniperTick)();

app.listen(config.port, () => {
  console.log(`Emerald Gate engine on :${config.port}`);
  console.log(`Live trading: ${config.liveTrading ? "ENABLED (pro users trade real money)" : "signal mode"}`);
});
