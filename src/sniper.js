// Sniper loop: discovers fresh launches from DEXScreener (profiles + boosts),
// runs the full intelligent gate once globally, writes the result as a signal
// visible to every account (FOMO tier included), then fans TRADE_READY tokens
// out to every eligible user (sniperEnabled + pro plan + funded wallet).
import { config, mergeSettings, DEFAULT_SETTINGS } from "./config.js";
import { latestBoosted, latestTokenProfiles } from "./dexscreener.js";
import { q } from "./supabase.js";
import { evaluateToken, openPositionFor } from "./trading.js";
import { balanceSol, ensureUserWallet } from "./wallets.js";

const seen = new Map();
const SEEN_TTL = 10 * 60_000;
let latestScan = { ts: null, candidates: [] };
export const getLatestScan = () => latestScan;

export async function sniperTick() {
  const [profiles, boosts] = await Promise.all([
    latestTokenProfiles().catch(() => []), latestBoosted().catch(() => []),
  ]);
  const now = Date.now();
  for (const [m, t] of seen) if (now - t > SEEN_TTL) seen.delete(m);
  const mints = [...new Set([...profiles, ...boosts].map(t => t.tokenAddress))]
    .filter(m => !seen.has(m)).slice(0, 8);

  const candidates = [];
  for (const mint of mints) {
    seen.set(mint, now);
    try {
      const ev = await evaluateToken(mint, DEFAULT_SETTINGS.entry);
      const snap = ev.snapshot;
      if (!snap) continue;
      const ageMin = snap.pairCreatedAt ? (now - snap.pairCreatedAt) / 60000 : null;
      if (ageMin !== null && ageMin > DEFAULT_SETTINGS.entry.maxPairAgeMin) continue;

      const candidate = {
        mint, symbol: snap.baseToken?.symbol, price_usd: snap.priceUsd,
        liquidity_usd: snap.liquidityUsd, checks: ev.checks,
        security: ev.security?.checks || null, trade_ready: ev.tradeReady,
      };
      candidates.push({ ...candidate, ageMin: ageMin && Math.round(ageMin), txns5m: snap.txns5m, url: snap.url });
      await q.insertSignal(candidate).catch(() => {});

      if (ev.tradeReady) await fanOutBuy(mint, snap);
    } catch (e) { console.error(`sniper ${mint.slice(0, 8)}: ${e.message}`); }
  }
  latestScan = { ts: now, candidates };
}

async function fanOutBuy(mint, snap) {
  const users = await q.allProfiles();
  for (const profile of users) {
    try {
      const settings = mergeSettings(await q.settings(profile.id));
      if (!settings.sniperEnabled) continue;
      const pk = await ensureUserWallet(profile.id);
      const bal = await balanceSol(pk).catch(() => 0);
      const funded = bal >= settings.buySizeSol + 0.01; // buy + fees
      if (profile.plan === "pro" && config.liveTrading && !funded) continue; // no funds → skip silently
      await openPositionFor({
        userId: profile.id, profile, settings, mint, snapshot: snap,
        source: "sniper", sizeSol: settings.buySizeSol,
      });
    } catch (e) { console.error(`fanout ${profile.id}: ${e.message}`); }
  }
}
