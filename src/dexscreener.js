// DEXScreener public API client.
// Discovery and live market refresh are intentionally separated:
// - profiles/boosts discover tokens
// - tokens/v1 batch-refreshes current market data for tracked tokens
const BASE = "https://api.dexscreener.com";

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`DEXScreener ${res.status} for ${url}`);
  }

  return res.json();
}

// Latest token profiles (newly listed or recently updated profiles).
export async function latestTokenProfiles() {
  const data = await getJson(`${BASE}/token-profiles/latest/v1`);
  return (Array.isArray(data) ? data : [])
    .filter(token => token.chainId === "solana");
}

// Latest boosted tokens.
export async function latestBoosted() {
  const data = await getJson(`${BASE}/token-boosts/latest/v1`);
  return (Array.isArray(data) ? data : [])
    .filter(token => token.chainId === "solana");
}

// Has the project paid for a DEXScreener profile/ad/boost order?
export async function paidOrders(tokenAddress) {
  const data = await getJson(
    `${BASE}/orders/v1/solana/${encodeURIComponent(tokenAddress)}`
  );
  return Array.isArray(data) ? data : [];
}

// Live pairs for one token.
export async function tokenPairs(tokenAddress) {
  const data = await getJson(
    `${BASE}/tokens/v1/solana/${encodeURIComponent(tokenAddress)}`
  );

  return (Array.isArray(data) ? data : [])
    .filter(pair => pair.chainId === "solana");
}

// Live pairs for up to 30 token addresses in one request.
// This is used by the 5-second refresh loop so displayed prices do not freeze.
export async function tokenPairsBatch(tokenAddresses) {
  const unique = [...new Set((tokenAddresses || []).filter(Boolean))]
    .slice(0, 30);

  if (!unique.length) return [];

  const path = unique
    .map(address => encodeURIComponent(address))
    .join(",");

  const data = await getJson(`${BASE}/tokens/v1/solana/${path}`);

  return (Array.isArray(data) ? data : [])
    .filter(pair => pair.chainId === "solana");
}

// Pick the deepest available market for a token.
export function primaryPair(pairs) {
  if (!pairs?.length) return null;

  return [...pairs].sort(
    (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
  )[0];
}

// Group a batch response by requested token mint and select its deepest pair.
export function primaryPairsByMint(pairs, tokenAddresses) {
  const requested = new Set(tokenAddresses || []);
  const grouped = new Map();

  for (const pair of pairs || []) {
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;

    const mint = requested.has(base)
      ? base
      : requested.has(quote)
        ? quote
        : null;

    if (!mint) continue;

    if (!grouped.has(mint)) grouped.set(mint, []);
    grouped.get(mint).push(pair);
  }

  const result = new Map();

  for (const mint of requested) {
    const pair = primaryPair(grouped.get(mint) || []);
    if (pair) result.set(mint, pair);
  }

  return result;
}

export function pairSnapshot(pair, updatedAt = Date.now()) {
  if (!pair) return null;

  return {
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    baseToken: pair.baseToken,
    quoteToken: pair.quoteToken,
    priceUsd: Number(pair.priceUsd || 0),
    priceNative: Number(pair.priceNative || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0),
    liquidityBaseQuote: pair.liquidity || null,
    fdv: pair.fdv ?? null,
    marketCap: pair.marketCap ?? null,
    txns5m: pair.txns?.m5 || { buys: 0, sells: 0 },
    txns1h: pair.txns?.h1 || { buys: 0, sells: 0 },
    volume5m: Number(pair.volume?.m5 || 0),
    volume1h: Number(pair.volume?.h1 || 0),
    priceChange5m: Number(pair.priceChange?.m5 || 0),
    priceChange1h: Number(pair.priceChange?.h1 || 0),
    pairCreatedAt: pair.pairCreatedAt || null,
    socials: pair.info?.socials || [],
    websites: pair.info?.websites || [],
    url: pair.url,
    marketUpdatedAt: updatedAt,
  };
}
