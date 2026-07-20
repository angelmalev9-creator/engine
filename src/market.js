// Dense Solana market feed used by the scanner UI.
//
// Discovery combines public DEXScreener discovery endpoints with
// GeckoTerminal new/trending pools. Live market values are then refreshed
// from DEXScreener in batches every five seconds.
import {
  latestAds,
  latestBoosted,
  latestCommunityTakeovers,
  latestTokenProfiles,
  paidOrders,
  pairSnapshot,
  primaryPair,
  primaryPairsByMint,
  tokenPairs,
  tokenPairsBatch,
  topBoosted,
} from "./dexscreener.js";
import { mergeSettings } from "./config.js";
import { runSecurityGate } from "./security.js";
import { q } from "./supabase.js";
import { evaluateToken, openPositionFor } from "./trading.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const FEED_LIMIT = 180;
const DEX_BATCH_SIZE = 30;
const SNAPSHOT_LIMIT = 1_440;
const SECURITY_TTL = 10 * 60_000;
const DETAIL_TTL = 5 * 60_000;

const items = new Map();
const liveHistory = new Map();
const detailCache = new Map();
const chartCache = new Map();

let discoveryTs = null;
let refreshTs = null;
let refreshCursor = 0;
let discoveryRunning = false;
let refreshRunning = false;
let securityRunning = false;
let autoTradeRunning = false;

const AUTO_EVALUATION_TTL = 30_000;
const AUTO_MAX_EVALUATIONS_PER_TICK = 15;
const AUTO_MAX_INSPECTIONS_PER_TICK = 90;

let autoCandidateCursor = 0;
const autoEvaluationCache = new Map();

let autoTradeStatus = {
  enabledUsers: 0,
  lastRunAt: null,
  lastOpenedAt: null,
  lastOpenedMint: null,
  lastOpenedSymbol: null,
  lastDecision: "waiting for live markets",
  evaluations: 0,
  opened: 0,
  profile: "active",
  rejections: {},
};

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stripNetworkPrefix(value) {
  if (!value) return null;
  const string = String(value);
  return string.startsWith("solana_")
    ? string.slice("solana_".length)
    : string;
}

async function geckoJson(path) {
  const response = await fetch(`${GECKO_BASE}${path}`, {
    headers: {
      accept: "application/json;version=20230203",
      "user-agent": "EmeraldGate/3.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GeckoTerminal ${response.status} for ${path}`);
  }

  return response.json();
}

function addSource(mint, source, metadata = {}) {
  if (!mint) return;

  const current = items.get(mint) || {
    mint,
    name: metadata.name || mint.slice(0, 6),
    symbol: metadata.symbol || mint.slice(0, 6),
    image_url: metadata.imageUrl || null,
    sources: [],
    discovered_at: Date.now(),
    market_updated_at: null,
    market_stale: true,
    dex_paid: false,
    security_checked: false,
    security_pass: null,
    top10_pct: null,
    rugcheck_score: null,
    lp_locked_pct: null,
  };

  current.sources = [...new Set([...(current.sources || []), source])];
  current.last_discovered_at = Date.now();

  if (metadata.name) current.name = metadata.name;
  if (metadata.symbol) current.symbol = metadata.symbol;
  if (metadata.imageUrl) current.image_url = metadata.imageUrl;
  if (metadata.pairAddress && !current.pair_address) {
    current.pair_address = metadata.pairAddress;
  }
  if (metadata.dexId && !current.dex_id) current.dex_id = metadata.dexId;

  if (["boosted", "top_boosted", "ad"].includes(source)) {
    current.dex_paid = true;
  }

  items.set(mint, current);
}

function discoverDexItems(list, source) {
  for (const token of list || []) {
    addSource(token.tokenAddress, source, {
      imageUrl: token.icon || null,
    });
  }
}

function includedMap(payload) {
  const map = new Map();

  for (const item of payload?.included || []) {
    map.set(item.id, item);
  }

  return map;
}

function discoverGeckoPools(payload, source) {
  const included = includedMap(payload);

  for (const pool of payload?.data || []) {
    const relationships = pool.relationships || {};
    const baseId = relationships.base_token?.data?.id;
    const quoteId = relationships.quote_token?.data?.id;
    const base = included.get(baseId);
    const quote = included.get(quoteId);

    const baseAddress =
      base?.attributes?.address || stripNetworkPrefix(baseId);
    const quoteAddress =
      quote?.attributes?.address || stripNetworkPrefix(quoteId);

    // SOL and stablecoins should not become the displayed target token.
    const quoteSymbols = new Set(["SOL", "WSOL", "USDC", "USDT"]);
    const baseSymbol = base?.attributes?.symbol || "";
    const quoteSymbol = quote?.attributes?.symbol || "";

    const target = quoteSymbols.has(baseSymbol.toUpperCase())
      ? {
          mint: quoteAddress,
          token: quote,
        }
      : {
          mint: baseAddress,
          token: base,
        };

    if (!target.mint) continue;

    addSource(target.mint, source, {
      pairAddress:
        pool.attributes?.address || stripNetworkPrefix(pool.id),
      dexId:
        stripNetworkPrefix(relationships.dex?.data?.id),
      name: target.token?.attributes?.name,
      symbol: target.token?.attributes?.symbol,
      imageUrl: target.token?.attributes?.image_url,
    });
  }
}

function trimFeed() {
  if (items.size <= FEED_LIMIT) return;

  const ordered = [...items.values()].sort(
    (left, right) =>
      safeNumber(right.last_discovered_at) -
      safeNumber(left.last_discovered_at)
  );

  const keep = new Set(
    ordered.slice(0, FEED_LIMIT).map(item => item.mint)
  );

  for (const mint of items.keys()) {
    if (!keep.has(mint)) {
      items.delete(mint);
      detailCache.delete(mint);
    }
  }
}

export async function marketDiscoveryTick() {
  if (discoveryRunning) return;
  discoveryRunning = true;

  try {
    const [
      profiles,
      boosted,
      top,
      takeovers,
      ads,
      geckoNew,
      geckoTrending,
    ] = await Promise.all([
      latestTokenProfiles().catch(() => []),
      latestBoosted().catch(() => []),
      topBoosted().catch(() => []),
      latestCommunityTakeovers().catch(() => []),
      latestAds().catch(() => []),
      geckoJson(
        "/networks/solana/new_pools?page=1&include=base_token,quote_token,dex"
      ).catch(() => ({ data: [], included: [] })),
      geckoJson(
        "/networks/solana/trending_pools?page=1&include=base_token,quote_token,dex"
      ).catch(() => ({ data: [], included: [] })),
    ]);

    discoverDexItems(profiles, "profile");
    discoverDexItems(boosted, "boosted");
    discoverDexItems(top, "top_boosted");
    discoverDexItems(takeovers, "takeover");
    discoverDexItems(ads, "ad");
    discoverGeckoPools(geckoNew, "new_pool");
    discoverGeckoPools(geckoTrending, "trending");

    trimFeed();
    discoveryTs = Date.now();
  } finally {
    discoveryRunning = false;
  }
}

function trendScore(snapshot) {
  const transactions =
    safeNumber(snapshot.txns5m?.buys) +
    safeNumber(snapshot.txns5m?.sells);

  const buyRatio = snapshot.txns5m?.sells > 0
    ? snapshot.txns5m.buys / snapshot.txns5m.sells
    : snapshot.txns5m?.buys > 0
      ? 4
      : 0;

  return (
    Math.log10(Math.max(1, snapshot.volume5m)) * 22 +
    Math.log10(Math.max(1, snapshot.liquidityUsd)) * 12 +
    Math.log10(Math.max(1, transactions)) * 16 +
    Math.min(50, Math.max(-25, snapshot.priceChange5m)) +
    Math.min(12, buyRatio * 3) +
    Math.min(15, snapshot.boostsActive * 2)
  );
}

function pushHistory(item) {
  if (!item.pair_address || !item.price_usd) return;

  const history = liveHistory.get(item.pair_address) || [];
  history.push({
    ts: Math.floor(Date.now() / 1000),
    price: item.price_usd,
  });

  if (history.length > SNAPSHOT_LIMIT) {
    history.splice(0, history.length - SNAPSHOT_LIMIT);
  }

  liveHistory.set(item.pair_address, history);
}

function mergeSnapshot(item, snapshot) {
  const createdAt = snapshot.pairCreatedAt || null;
  const ageMinutes = createdAt
    ? (Date.now() - createdAt) / 60_000
    : null;

  const buys5m = safeNumber(snapshot.txns5m?.buys);
  const sells5m = safeNumber(snapshot.txns5m?.sells);
  const transactions5m = buys5m + sells5m;
  const buySellRatio = sells5m > 0
    ? buys5m / sells5m
    : buys5m > 0
      ? 999
      : 0;

  const targetToken = snapshot.baseToken?.address === item.mint
    ? snapshot.baseToken
    : snapshot.quoteToken?.address === item.mint
      ? snapshot.quoteToken
      : snapshot.baseToken;

  Object.assign(item, {
    name: targetToken?.name || item.name,
    symbol: targetToken?.symbol || item.symbol,
    image_url: snapshot.imageUrl || item.image_url,
    pair_address: snapshot.pairAddress,
    dex_id: snapshot.dexId,
    labels: snapshot.labels,
    quote_symbol: snapshot.quoteToken?.symbol || null,
    price_usd: snapshot.priceUsd,
    price_native: snapshot.priceNative,
    liquidity_usd: snapshot.liquidityUsd,
    market_cap: snapshot.marketCap,
    fdv: snapshot.fdv,
    age_minutes: ageMinutes,
    pair_created_at: createdAt,
    buys_5m: buys5m,
    sells_5m: sells5m,
    txns_5m: transactions5m,
    buy_sell_ratio: buySellRatio,
    buys_1h: safeNumber(snapshot.txns1h?.buys),
    sells_1h: safeNumber(snapshot.txns1h?.sells),
    buys_6h: safeNumber(snapshot.txns6h?.buys),
    sells_6h: safeNumber(snapshot.txns6h?.sells),
    buys_24h: safeNumber(snapshot.txns24h?.buys),
    sells_24h: safeNumber(snapshot.txns24h?.sells),
    volume_5m: snapshot.volume5m,
    volume_1h: snapshot.volume1h,
    volume_6h: snapshot.volume6h,
    volume_24h: snapshot.volume24h,
    change_5m: snapshot.priceChange5m,
    change_1h: snapshot.priceChange1h,
    change_6h: snapshot.priceChange6h,
    change_24h: snapshot.priceChange24h,
    socials: snapshot.socials,
    websites: snapshot.websites,
    boosts_active: snapshot.boostsActive,
    dex_url: snapshot.url,
    market_updated_at: snapshot.marketUpdatedAt,
    market_stale: false,
    trend_score: trendScore(snapshot),
  });

  if (snapshot.boostsActive > 0) item.dex_paid = true;

  pushHistory(item);
}

export async function marketRefreshTick() {
  if (refreshRunning || !items.size) return;
  refreshRunning = true;

  try {
    const mints = [...items.keys()];

    if (refreshCursor >= mints.length) refreshCursor = 0;

    const batch = mints.slice(
      refreshCursor,
      refreshCursor + DEX_BATCH_SIZE
    );

    refreshCursor += DEX_BATCH_SIZE;

    if (batch.length < DEX_BATCH_SIZE && mints.length > batch.length) {
      const wrappedCount = DEX_BATCH_SIZE - batch.length;
      batch.push(...mints.slice(0, wrappedCount));
      refreshCursor = wrappedCount;
    }

    const pairs = await tokenPairsBatch(batch);
    const grouped = primaryPairsByMint(pairs, batch);
    const updatedAt = Date.now();

    for (const mint of batch) {
      const item = items.get(mint);
      if (!item) continue;

      const pair = grouped.get(mint);

      if (!pair) {
        item.market_stale = true;
        continue;
      }

      mergeSnapshot(item, pairSnapshot(pair, updatedAt));
    }

    refreshTs = updatedAt;
  } finally {
    refreshRunning = false;
  }
}

function securityFields(result) {
  const checks = result?.checks || {};

  return {
    security_checked: true,
    security_pass: Boolean(result?.pass),
    top10_pct: checks.topHolders?.pct ?? null,
    rugcheck_score: checks.rugcheck?.score ?? null,
    lp_locked_pct: checks.lpLocked?.pct ?? null,
    security_checks: checks,
    security_checked_at: Date.now(),
  };
}

export async function marketSecurityTick() {
  if (securityRunning) return;
  securityRunning = true;

  try {
    const candidate = [...items.values()]
      .filter(item => {
        if (!item.pair_address) return false;
        if (item.market_stale) return false;
        if (item.age_minutes !== null && item.age_minutes > 180) return false;
        if (safeNumber(item.liquidity_usd) < 2_000) return false;

        return !item.security_checked_at ||
          Date.now() - item.security_checked_at > SECURITY_TTL;
      })
      .sort((left, right) =>
        safeNumber(right.trend_score) - safeNumber(left.trend_score)
      )[0];

    if (!candidate) return;

    const [security, orders] = await Promise.all([
      runSecurityGate(candidate.mint, {
        primaryPairAddress: candidate.pair_address,
      }).catch(error => ({
        pass: false,
        checks: {
          error: { pass: false, detail: error.message },
        },
      })),
      paidOrders(candidate.mint).catch(() => []),
    ]);

    Object.assign(candidate, securityFields(security), {
      dex_paid:
        candidate.dex_paid ||
        orders.some(order => order.status === "approved"),
      paid_orders: orders,
    });
  } finally {
    securityRunning = false;
  }
}


function entryPrefilter(item, entry) {
  if (!item?.mint || !item.pair_address) {
    return { pass: false, reason: "missing pair" };
  }

  if (item.market_stale || !Number(item.price_usd)) {
    return { pass: false, reason: "stale market" };
  }

  if (
    item.age_minutes !== null &&
    item.age_minutes !== undefined &&
    Number(item.age_minutes) > Number(entry.maxPairAgeMin)
  ) {
    return { pass: false, reason: "pair too old" };
  }

  const transactions = safeNumber(item.txns_5m);
  if (transactions <= Number(entry.minTxns5m)) {
    return { pass: false, reason: "not enough 5m transactions" };
  }

  if (safeNumber(item.buy_sell_ratio) < Number(entry.minBuySellRatio)) {
    return { pass: false, reason: "buy/sell ratio too low" };
  }

  if (entry.requireDexPaid && !item.dex_paid) {
    return { pass: false, reason: "DEX paid/boost required" };
  }

  if (entry.requireSocials && !(item.socials || []).length) {
    return { pass: false, reason: "social profile required" };
  }

  // Convert the pool's USD liquidity to an approximate SOL value using the
  // token's USD/native relationship returned by DEXScreener.
  const solUsd =
    safeNumber(item.price_native) > 0 &&
    safeNumber(item.price_usd) > 0
      ? safeNumber(item.price_usd) / safeNumber(item.price_native)
      : null;

  const liquiditySol =
    solUsd && solUsd > 0
      ? safeNumber(item.liquidity_usd) / solUsd
      : null;

  if (
    liquiditySol === null ||
    liquiditySol <= Number(entry.minLiquiditySol)
  ) {
    return { pass: false, reason: "liquidity below strategy minimum" };
  }

  return { pass: true, liquiditySol };
}


function activePaperEntry(entry) {
  return {
    ...entry,
    // ACTIVE is deliberately broad enough to build a PAPER performance sample.
    // It never changes LIVE-money entry rules.
    minLiquiditySol: Math.min(Number(entry.minLiquiditySol || 15), 2),
    minTxns5m: Math.min(Number(entry.minTxns5m || 80), 5),
    minBuySellRatio: Math.min(Number(entry.minBuySellRatio || 2), 0.8),
    maxPairAgeMin: Math.max(Number(entry.maxPairAgeMin || 60), 720),
    requireDexPaid: false,
    requireSocials: false,
  };
}

function failedCheckText(evaluation) {
  const checks = {
    ...(evaluation?.checks || {}),
    ...(evaluation?.security?.checks || {}),
  };

  return Object.entries(checks)
    .filter(([, check]) => !check?.pass)
    .map(([name, check]) => `${name}: ${check?.detail || "failed"}`)
    .join(" | ");
}

// PAPER active mode still blocks the clear danger signals.
// LP matching remains a warning because Rugcheck and DEXScreener pair
// identifiers frequently differ even when the pool is real.
function isUnavailableCheck(check) {
  const detail = String(check?.detail || "").toLowerCase();

  return (
    detail.includes("unavailable") ||
    detail.includes("no rugcheck score") ||
    detail.includes("not readable") ||
    detail.includes("timeout") ||
    detail.includes("429") ||
    detail.includes("503")
  );
}

function activePaperSecurityPass(security) {
  const checks = security?.checks || {};

  // A real active mint/freeze authority is always blocked.
  if (!checks.authorities?.pass) return false;

  // Explicitly excessive holder concentration is blocked.
  // Temporary provider/RPC gaps remain warnings in PAPER only.
  if (
    checks.topHolders &&
    !checks.topHolders.pass &&
    !isUnavailableCheck(checks.topHolders)
  ) {
    return false;
  }

  // A real bad Rugcheck score is blocked. Missing provider data is a warning
  // in ACTIVE PAPER so the performance test does not stall forever.
  if (
    checks.rugcheck &&
    !checks.rugcheck.pass &&
    !isUnavailableCheck(checks.rugcheck)
  ) {
    return false;
  }

  return true;
}

function addRejection(rejections, reason) {
  const key = String(reason || "unknown").slice(0, 120);
  rejections[key] = (rejections[key] || 0) + 1;
}

function evaluationCacheKey(mint, entry) {
  return `${mint}:${JSON.stringify(entry)}`;
}

async function cachedAutoEvaluation(mint, entry) {
  const key = evaluationCacheKey(mint, entry);
  const hit = autoEvaluationCache.get(key);

  if (hit && Date.now() - hit.ts < AUTO_EVALUATION_TTL) {
    return hit.value;
  }

  const value = await evaluateToken(mint, entry);
  autoEvaluationCache.set(key, { ts: Date.now(), value });

  if (autoEvaluationCache.size > 300) {
    const cutoff = Date.now() - AUTO_EVALUATION_TTL;

    for (const [cacheKey, entryValue] of autoEvaluationCache) {
      if (entryValue.ts < cutoff) autoEvaluationCache.delete(cacheKey);
    }
  }

  return value;
}

function recentMintCooldown(positions, mint, cooldownMinutes) {
  const cutoff = Date.now() - Math.max(0, cooldownMinutes) * 60_000;

  return positions.some(position => {
    if (position.mint !== mint) return false;

    const openedAt = new Date(position.opened_at || 0).getTime();
    return Number.isFinite(openedAt) && openedAt >= cutoff;
  });
}

// Connects the dense DEX-style scanner to the PAPER wallet.
//
// It intentionally refuses LIVE mode. Real-money execution remains protected
// behind the separate per-user LIVE selection and Railway kill switch.
export async function marketAutoTradeTick() {
  if (autoTradeRunning) return;
  autoTradeRunning = true;

  const runStartedAt = Date.now();
  let evaluations = 0;
  let opened = 0;
  let enabledUsers = 0;
  let inspected = 0;
  let lastDecision = "no PAPER user had entry capacity";
  let profileName = "active";
  const rejections = {};

  try {
    const profiles = await q.allProfiles();

    const rankedMarkets = [...items.values()]
      .filter(item =>
        item?.mint &&
        item?.pair_address &&
        !item.market_stale &&
        Number(item.price_usd) > 0
      )
      .sort((left, right) =>
        safeNumber(right.trend_score) - safeNumber(left.trend_score)
      );

    if (!rankedMarkets.length) {
      lastDecision = "market feed has no fresh priced pairs yet";
      addRejection(rejections, lastDecision);
    }

    const startIndex = rankedMarkets.length
      ? autoCandidateCursor % rankedMarkets.length
      : 0;

    // Rotate through the full feed instead of evaluating the same top three
    // rejected tokens forever.
    const rotatedMarkets = rankedMarkets.length
      ? [
          ...rankedMarkets.slice(startIndex),
          ...rankedMarkets.slice(0, startIndex),
        ]
      : [];

    for (const profile of profiles) {
      const settings = mergeSettings(await q.settings(profile.id));

      if (
        settings.tradingMode !== "paper" ||
        !settings.sniperEnabled ||
        settings.paperAutoTradeEnabled === false
      ) {
        continue;
      }

      enabledUsers += 1;
      profileName =
        settings.paperStrategyProfile === "strict"
          ? "strict"
          : "active";

      const entry =
        profileName === "strict"
          ? settings.entry
          : activePaperEntry(settings.entry);

      const positions = await q.userPositions(profile.id, 250);

      const active = positions.filter(position =>
        position.status === "open" || position.status === "alert"
      );

      let capacity = Math.max(
        0,
        Number(settings.maxOpenPositions) - active.length
      );

      if (!capacity) {
        lastDecision = "max PAPER positions reached";
        addRejection(rejections, lastDecision);
        continue;
      }

      const entriesThisTick = Math.max(
        1,
        Math.min(3, Number(settings.paperAutoEntriesPerTick || 1))
      );

      let remainingEntries = Math.min(capacity, entriesThisTick);

      const cooldownMinutes = Math.max(
        0,
        Number(settings.paperReentryCooldownMin || 30)
      );

      for (const item of rotatedMarkets) {
        if (!remainingEntries) break;
        if (evaluations >= AUTO_MAX_EVALUATIONS_PER_TICK) break;
        if (inspected >= AUTO_MAX_INSPECTIONS_PER_TICK) break;

        inspected += 1;

        const prefilter = entryPrefilter(item, entry);

        if (!prefilter.pass) {
          lastDecision = prefilter.reason;
          addRejection(rejections, prefilter.reason);
          continue;
        }

        if (
          active.some(position => position.mint === item.mint) ||
          recentMintCooldown(positions, item.mint, cooldownMinutes)
        ) {
          lastDecision = "mint open or in re-entry cooldown";
          addRejection(rejections, lastDecision);
          continue;
        }

        evaluations += 1;

        let evaluation;

        try {
          evaluation = await cachedAutoEvaluation(item.mint, entry);
        } catch (error) {
          lastDecision = `evaluation error: ${error.message}`;
          addRejection(rejections, lastDecision);
          continue;
        }

        const velocityPass = Object.values(
          evaluation.checks || {}
        ).every(check => check.pass);

        const securityPass =
          profileName === "strict"
            ? Boolean(evaluation.tradeReady)
            : (
                velocityPass &&
                activePaperSecurityPass(evaluation.security)
              );

        if (!securityPass || !evaluation.snapshot) {
          const failed =
            failedCheckText(evaluation) ||
            "candidate failed strategy/security";

          lastDecision = failed;
          addRejection(rejections, failed);
          continue;
        }

        try {
          const position = await openPositionFor({
            userId: profile.id,
            profile,
            settings,
            mint: item.mint,
            snapshot: evaluation.snapshot,
            source:
              profileName === "strict"
                ? "market-scanner-strict"
                : "market-scanner-active",
            sizeSol: settings.buySizeSol,
          });

          if (!position) {
            lastDecision = "position already open or maximum reached";
            addRejection(rejections, lastDecision);
            continue;
          }

          opened += 1;
          remainingEntries -= 1;
          capacity -= 1;
          active.push(position);
          positions.push(position);

          autoTradeStatus.lastOpenedAt = Date.now();
          autoTradeStatus.lastOpenedMint = item.mint;
          autoTradeStatus.lastOpenedSymbol =
            evaluation.snapshot.baseToken?.symbol ||
            item.symbol ||
            item.mint.slice(0, 6);

          lastDecision =
            `opened PAPER ${autoTradeStatus.lastOpenedSymbol} ` +
            `with ${Number(settings.buySizeSol).toFixed(4)} SOL live quote`;

          console.log(
            `AUTO PAPER ${profile.id}: ` +
            `${autoTradeStatus.lastOpenedSymbol} ` +
            `${item.mint} size=${settings.buySizeSol} ` +
            `profile=${profileName}`
          );
        } catch (error) {
          lastDecision = `paper entry failed: ${error.message}`;
          addRejection(rejections, lastDecision);
        }
      }
    }

    if (!opened && inspected > 0) {
      lastDecision =
        `scanned ${inspected} markets / evaluated ${evaluations}; ` +
        lastDecision;
    }

    if (rankedMarkets.length) {
      autoCandidateCursor =
        (startIndex + Math.max(1, inspected)) % rankedMarkets.length;
    }
  } finally {
    autoTradeStatus = {
      ...autoTradeStatus,
      enabledUsers,
      lastRunAt: runStartedAt,
      lastDecision,
      evaluations,
      inspected,
      opened,
      profile: profileName,
      rejections,
    };

    autoTradeRunning = false;
  }
}

export function getAutoTradeStatus() {
  return { ...autoTradeStatus };
}


function publicItem(item) {
  return {
    ...item,
    security_checks: item.security_checks || null,
  };
}

export function getMarketFeed() {
  const list = [...items.values()]
    .filter(item => item.price_usd !== undefined)
    .sort((left, right) =>
      safeNumber(right.trend_score) - safeNumber(left.trend_score)
    )
    .map(publicItem);

  return {
    discoveryTs,
    refreshTs,
    count: list.length,
    autoTrader: getAutoTradeStatus(),
    items: list,
  };
}

export async function getMarketToken(mint) {
  const cached = detailCache.get(mint);

  if (cached && Date.now() - cached.ts < DETAIL_TTL) {
    return cached.value;
  }

  const pairs = await tokenPairs(mint);
  const pair = primaryPair(pairs);

  if (!pair) {
    throw new Error("No live Solana market pair found");
  }

  const snapshot = pairSnapshot(pair);
  const [security, orders] = await Promise.all([
    runSecurityGate(mint, {
      primaryPairAddress: snapshot.pairAddress,
    }).catch(error => ({
      pass: false,
      checks: {
        error: { pass: false, detail: error.message },
      },
    })),
    paidOrders(mint).catch(() => []),
  ]);

  const value = {
    mint,
    snapshot,
    security,
    orders,
    dexPaid: orders.some(order => order.status === "approved") ||
      snapshot.boostsActive > 0,
  };

  detailCache.set(mint, { ts: Date.now(), value });

  const item = items.get(mint);
  if (item) {
    Object.assign(item, securityFields(security), {
      dex_paid: value.dexPaid,
      paid_orders: orders,
    });
  }

  return value;
}

function aggregateLiveCandles(history, aggregateMinutes) {
  const seconds = Math.max(1, aggregateMinutes) * 60;
  const buckets = new Map();

  for (const point of history || []) {
    const time = Math.floor(point.ts / seconds) * seconds;
    const current = buckets.get(time);

    if (!current) {
      buckets.set(time, {
        time,
        open: point.price,
        high: point.price,
        low: point.price,
        close: point.price,
        volume: 0,
      });
    } else {
      current.high = Math.max(current.high, point.price);
      current.low = Math.min(current.low, point.price);
      current.close = point.price;
    }
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export async function getMarketChart(
  pairAddress,
  { timeframe = "minute", aggregate = 1, limit = 500 } = {}
) {
  const allowedTimeframes = new Set(["minute", "hour", "day"]);
  const safeTimeframe = allowedTimeframes.has(timeframe)
    ? timeframe
    : "minute";
  const safeAggregate = Math.max(1, Math.min(60, Number(aggregate) || 1));
  const safeLimit = Math.max(20, Math.min(1_000, Number(limit) || 500));
  const cacheKey = `${pairAddress}:${safeTimeframe}:${safeAggregate}:${safeLimit}`;
  const cached = chartCache.get(cacheKey);

  if (cached && Date.now() - cached.ts < 30_000) {
    return cached.value;
  }

  try {
    const payload = await geckoJson(
      `/networks/solana/pools/${encodeURIComponent(pairAddress)}` +
      `/ohlcv/${safeTimeframe}` +
      `?aggregate=${safeAggregate}` +
      `&limit=${safeLimit}` +
      "&currency=usd&token=base&include_empty_intervals=true"
    );

    const candles = (payload?.data?.attributes?.ohlcv_list || [])
      .map(row => ({
        time: safeNumber(row[0]),
        open: safeNumber(row[1]),
        high: safeNumber(row[2]),
        low: safeNumber(row[3]),
        close: safeNumber(row[4]),
        volume: safeNumber(row[5]),
      }))
      .filter(candle => candle.time && candle.close)
      .sort((left, right) => left.time - right.time);

    if (candles.length) {
      const value = {
        source: "geckoterminal",
        pairAddress,
        timeframe: safeTimeframe,
        aggregate: safeAggregate,
        candles,
      };
      chartCache.set(cacheKey, { ts: Date.now(), value });
      return value;
    }
  } catch (error) {
    console.error(`chart ${pairAddress.slice(0, 6)}: ${error.message}`);
  }

  const fallback = aggregateLiveCandles(
    liveHistory.get(pairAddress) || [],
    safeTimeframe === "minute" ? safeAggregate : 60
  );

  const value = {
    source: "live-snapshots",
    pairAddress,
    timeframe: safeTimeframe,
    aggregate: safeAggregate,
    candles: fallback,
  };
  chartCache.set(cacheKey, { ts: Date.now(), value });
  return value;
}

export function marketStatus() {
  return {
    discoveryTs,
    refreshTs,
    count: items.size,
    autoTrader: getAutoTradeStatus(),
    generatedAt: nowIso(),
  };
}
