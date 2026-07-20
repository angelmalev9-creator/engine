// Sniper loop: discovers fresh launches from DEXScreener profiles + boosts.
// Tokens without a live pair are retried after 5s, 10s and 15s instead of
// being discarded immediately.
import { config, mergeSettings, DEFAULT_SETTINGS } from "./config.js";
import { latestBoosted, latestTokenProfiles } from "./dexscreener.js";
import { q } from "./supabase.js";
import { evaluateToken, openPositionFor } from "./trading.js";
import { balanceSol, ensureUserWallet } from "./wallets.js";

const seen = new Map();
const pending = new Map();

const SEEN_TTL = 10 * 60_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 15_000];
const MAX_VISIBLE_CANDIDATES = 20;

let latestScan = { ts: null, candidates: [] };

export const getLatestScan = () => latestScan;

function firstFailure(evaluation) {
  const all = {
    ...(evaluation?.checks || {}),
    ...(evaluation?.security?.checks || {}),
  };

  const failed = Object.entries(all)
    .find(([, check]) => !check?.pass);

  return failed
    ? `${failed[0]}: ${failed[1]?.detail || "failed"}`
    : "";
}

function upsertCandidate(candidate) {
  const withoutCurrent = latestScan.candidates
    .filter(item => item.mint !== candidate.mint);

  latestScan = {
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
    const evaluation = await evaluateToken(mint, DEFAULT_SETTINGS.entry);
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
        url: snapshot.url,
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
      url: snapshot.url,
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
    ts: now,
    candidates: latestScan.candidates,
  };

  for (const mint of mints) {
    await processMint(mint, 0);
  }
}

async function fanOutBuy(mint, snapshot) {
  const users = await q.allProfiles();

  for (const profile of users) {
    try {
      const settings = mergeSettings(await q.settings(profile.id));
      if (!settings.sniperEnabled) continue;

      const publicKey = await ensureUserWallet(profile.id);
      const balance = await balanceSol(publicKey).catch(() => 0);
      const funded = balance >= Number(settings.buySizeSol) + 0.01;

      if (
        profile.plan === "pro" &&
        config.liveTrading &&
        !funded
      ) {
        console.log(
          `sniper skip ${profile.id}: insufficient balance ${balance.toFixed(4)} SOL`
        );
        continue;
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
