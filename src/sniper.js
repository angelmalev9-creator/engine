// Sniper discovery + continuously refreshed live market feed.
//
// Discovery runs every 30 seconds.
// Prices, liquidity, volume and transaction counts for visible candidates
// are batch-refreshed from DEXScreener every 5 seconds.
import { config, mergeSettings, DEFAULT_SETTINGS } from "./config.js";
import {
  latestBoosted,
  latestTokenProfiles,
  pairSnapshot,
  primaryPairsByMint,
  tokenPairsBatch,
} from "./dexscreener.js";
import { q } from "./supabase.js";
import { evaluateToken, openPositionFor } from "./trading.js";
import { balanceSol, ensureUserWallet } from "./wallets.js";

const seen = new Map();
const pending = new Map();

const SEEN_TTL = 10 * 60_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 15_000];
const MAX_VISIBLE_CANDIDATES = 20;

let latestScan = {
  ts: null,
  marketUpdatedAt: null,
  candidates: [],
};

let refreshRunning = false;

export const getLatestScan = () => latestScan;

function firstFailureFromMaps(checks, security) {
  const all = {
    ...(checks || {}),
    ...(security || {}),
  };

  const failed = Object.entries(all)
    .find(([, check]) => !check?.pass);

  return failed
    ? `${failed[0]}: ${failed[1]?.detail || "failed"}`
    : "";
}

function firstFailure(evaluation) {
  return firstFailureFromMaps(
    evaluation?.checks,
    evaluation?.security?.checks
  );
}

function upsertCandidate(candidate) {
  const withoutCurrent = latestScan.candidates
    .filter(item => item.mint !== candidate.mint);

  latestScan = {
    ...latestScan,
    ts: Date.now(),
    candidates: [candidate, ...withoutCurrent]
      .slice(0, MAX_VISIBLE_CANDIDATES),
  };
}

function scheduleRetry(mint, attempt) {
  if (pending.has(mint)) return;

  const delay = RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;

  const timer = setTimeout(async () => {
    pending.delete(mint);
    await processMint(mint, attempt + 1);
  }, delay);

  pending.set(mint, timer);
}

async function processMint(mint, attempt = 0) {
  try {
    const now = Date.now();
    const evaluation = await evaluateToken(
      mint,
      DEFAULT_SETTINGS.entry
    );
    const snapshot = evaluation.snapshot;

    if (!snapshot) {
      const finalAttempt = attempt >= RETRY_DELAYS_MS.length;

      upsertCandidate({
        mint,
        symbol: "?",
        price_usd: null,
        liquidity_usd: null,
        checks: evaluation.checks,
        security: null,
        trade_ready: false,
        stage: finalAttempt ? "FILTERED" : "WAITING_PAIR",
        reason: finalAttempt
          ? "no live Solana pair after retries"
          : `waiting for live market pair · retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`,
        market_updated_at: null,
        market_stale: true,
      });

      if (finalAttempt) {
        seen.set(mint, now);
      } else {
        scheduleRetry(mint, attempt);
      }

      return;
    }

    const ageMin = snapshot.pairCreatedAt
      ? (now - snapshot.pairCreatedAt) / 60_000
      : null;

    if (
      ageMin !== null &&
      ageMin > DEFAULT_SETTINGS.entry.maxPairAgeMin
    ) {
      seen.set(mint, now);

      upsertCandidate({
        mint,
        symbol: snapshot.baseToken?.symbol,
        price_usd: snapshot.priceUsd,
        liquidity_usd: snapshot.liquidityUsd,
        checks: evaluation.checks,
        security: evaluation.security?.checks || null,
        trade_ready: false,
        stage: "FILTERED",
        reason: `pair age ${Math.round(ageMin)}m exceeds ${DEFAULT_SETTINGS.entry.maxPairAgeMin}m limit`,
        ageMin: Math.round(ageMin),
        txns5m: snapshot.txns5m,
        volume5m: snapshot.volume5m,
        price_change_5m: snapshot.priceChange5m ?? 0,
        market_cap: snapshot.marketCap ?? null,
        fdv: snapshot.fdv ?? null,
        pair_address: snapshot.pairAddress,
        url: snapshot.url,
        market_updated_at: snapshot.marketUpdatedAt || now,
        market_stale: false,
      });

      return;
    }

    seen.set(mint, now);

    const dbCandidate = {
      mint,
      symbol: snapshot.baseToken?.symbol,
      price_usd: snapshot.priceUsd,
      liquidity_usd: snapshot.liquidityUsd,
      checks: evaluation.checks,
      security: evaluation.security?.checks || null,
      trade_ready: evaluation.tradeReady,
    };

    const uiCandidate = {
      ...dbCandidate,
      stage: evaluation.tradeReady ? "TRADE_READY" : "FILTERED",
      reason: evaluation.tradeReady ? "" : firstFailure(evaluation),
      ageMin: ageMin === null ? null : Math.round(ageMin),
      txns5m: snapshot.txns5m,
      volume5m: snapshot.volume5m,
      price_change_5m: snapshot.priceChange5m ?? 0,
      market_cap: snapshot.marketCap ?? null,
      fdv: snapshot.fdv ?? null,
      pair_address: snapshot.pairAddress,
      url: snapshot.url,
      market_updated_at: snapshot.marketUpdatedAt || now,
      market_stale: false,
    };

    upsertCandidate(uiCandidate);
    await q.insertSignal(dbCandidate).catch(() => {});

    if (evaluation.tradeReady) {
      await fanOutBuy(mint, snapshot);
    }
  } catch (error) {
    console.error(`sniper ${mint.slice(0, 8)}: ${error.message}`);

    upsertCandidate({
      mint,
      symbol: "?",
      price_usd: null,
      liquidity_usd: null,
      checks: {},
      security: null,
      trade_ready: false,
      stage: "FILTERED",
      reason: `scanner error: ${error.message}`,
      market_updated_at: null,
      market_stale: true,
    });

    seen.set(mint, Date.now());
  }
}

export async function sniperTick() {
  const [profiles, boosts] = await Promise.all([
    latestTokenProfiles().catch(() => []),
    latestBoosted().catch(() => []),
  ]);

  const now = Date.now();

  for (const [mint, ts] of seen) {
    if (now - ts > SEEN_TTL) seen.delete(mint);
  }

  const mints = [...new Set(
    [...profiles, ...boosts]
      .map(token => token.tokenAddress)
      .filter(Boolean)
  )]
    .filter(mint => !seen.has(mint) && !pending.has(mint))
    .slice(0, 8);

  latestScan = {
    ...latestScan,
    ts: now,
  };

  for (const mint of mints) {
    await processMint(mint, 0);
  }

  // Refresh immediately after discovery rather than waiting for the next 5s tick.
  await refreshMarketData().catch(() => {});
}

// Re-fetch live values for every visible token in one DEXScreener request.
// If DEXScreener temporarily returns no pair, preserve the last real values
// and mark the row stale instead of inventing zeros or random prices.
export async function refreshMarketData() {
  if (refreshRunning) return;
  refreshRunning = true;

  try {
    const mints = [...new Set(
      latestScan.candidates
        .map(candidate => candidate.mint)
        .filter(Boolean)
    )].slice(0, 30);

    if (!mints.length) return;

    const now = Date.now();
    const pairs = await tokenPairsBatch(mints);
    const pairsByMint = primaryPairsByMint(pairs, mints);

    const candidates = latestScan.candidates.map(candidate => {
      const pair = pairsByMint.get(candidate.mint);

      if (!pair) {
        return {
          ...candidate,
          market_stale: true,
        };
      }

      const snapshot = pairSnapshot(pair, now);
      const ageMin = snapshot.pairCreatedAt
        ? (now - snapshot.pairCreatedAt) / 60_000
        : candidate.ageMin ?? null;

      return {
        ...candidate,
        symbol: snapshot.baseToken?.symbol || candidate.symbol,
        price_usd: snapshot.priceUsd,
        liquidity_usd: snapshot.liquidityUsd,
        txns5m: snapshot.txns5m,
        volume5m: snapshot.volume5m,
        volume1h: snapshot.volume1h,
        price_change_5m: snapshot.priceChange5m,
        price_change_1h: snapshot.priceChange1h,
        market_cap: snapshot.marketCap,
        fdv: snapshot.fdv,
        pair_address: snapshot.pairAddress,
        url: snapshot.url,
        ageMin: ageMin === null ? null : Math.round(ageMin),
        market_updated_at: now,
        market_stale: false,
      };
    });

    latestScan = {
      ...latestScan,
      marketUpdatedAt: now,
      candidates,
    };
  } catch (error) {
    console.error(`market refresh: ${error.message}`);

    latestScan = {
      ...latestScan,
      candidates: latestScan.candidates.map(candidate => ({
        ...candidate,
        market_stale: true,
      })),
    };
  } finally {
    refreshRunning = false;
  }
}

async function fanOutBuy(mint, snapshot) {
  const users = await q.allProfiles();

  for (const profile of users) {
    try {
      const settings = mergeSettings(await q.settings(profile.id));
      if (!settings.sniperEnabled) continue;

      if (settings.tradingMode === "live") {
        const publicKey = await ensureUserWallet(profile.id);
        const balance = await balanceSol(publicKey).catch(() => 0);
        const required = Number(settings.buySizeSol) + 0.01;

        if (
          profile.plan !== "pro" ||
          !config.liveTrading ||
          balance < required
        ) {
          console.log(
            `sniper live skip ${profile.id}: plan=${profile.plan}, global=${config.liveTrading}, balance=${balance.toFixed(4)}`
          );
          continue;
        }
      }

      await openPositionFor({
        userId: profile.id,
        profile,
        settings,
        mint,
        snapshot,
        source: "sniper",
        sizeSol: settings.buySizeSol,
      });
    } catch (error) {
      console.error(`fanout ${profile.id}: ${error.message}`);
    }
  }
}
