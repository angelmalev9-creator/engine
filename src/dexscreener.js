// DEXScreener public API client.
// Discovery and price refresh are separate so visible market rows never freeze.
const BASE = "https://api.dexscreener.com";

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`DEXScreener ${response.status} for ${url}`);
  }

  return response.json();
}

function solanaOnly(items) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item?.chainId === "solana");
}

export async function latestTokenProfiles() {
  return solanaOnly(
    await getJson(`${BASE}/token-profiles/latest/v1`)
  );
}

export async function latestBoosted() {
  return solanaOnly(
    await getJson(`${BASE}/token-boosts/latest/v1`)
  );
}

export async function topBoosted() {
  return solanaOnly(
    await getJson(`${BASE}/token-boosts/top/v1`)
  );
}

export async function latestCommunityTakeovers() {
  return solanaOnly(
    await getJson(`${BASE}/community-takeovers/latest/v1`)
  );
}

export async function latestAds() {
  return solanaOnly(
    await getJson(`${BASE}/ads/latest/v1`)
  );
}

export async function paidOrders(tokenAddress) {
  const data = await getJson(
    `${BASE}/orders/v1/solana/${encodeURIComponent(tokenAddress)}`
  );

  return Array.isArray(data) ? data : [];
}

export async function searchPairs(query) {
  const data = await getJson(
    `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`
  );

  return solanaOnly(data?.pairs || []);
}

export async function pairByAddress(pairAddress) {
  const data = await getJson(
    `${BASE}/latest/dex/pairs/solana/${encodeURIComponent(pairAddress)}`
  );

  return solanaOnly(data?.pairs || []);
}

export async function tokenPairs(tokenAddress) {
  const data = await getJson(
    `${BASE}/tokens/v1/solana/${encodeURIComponent(tokenAddress)}`
  );

  return solanaOnly(data);
}

// DEXScreener supports up to 30 comma-separated token addresses.
export async function tokenPairsBatch(tokenAddresses) {
  const unique = [...new Set((tokenAddresses || []).filter(Boolean))]
    .slice(0, 30);

  if (!unique.length) return [];

  const path = unique
    .map(address => encodeURIComponent(address))
    .join(",");

  const data = await getJson(`${BASE}/tokens/v1/solana/${path}`);
  return solanaOnly(data);
}

export function primaryPair(pairs) {
  if (!pairs?.length) return null;

  return [...pairs].sort((left, right) => {
    const liquidityDifference =
      Number(right.liquidity?.usd || 0) -
      Number(left.liquidity?.usd || 0);

    if (liquidityDifference !== 0) return liquidityDifference;

    return Number(right.volume?.h24 || 0) -
      Number(left.volume?.h24 || 0);
  })[0];
}

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

function periodObject(container, period) {
  return container?.[period] || {};
}

export function pairSnapshot(pair, updatedAt = Date.now()) {
  if (!pair) return null;

  const txns5m = periodObject(pair.txns, "m5");
  const txns1h = periodObject(pair.txns, "h1");
  const txns6h = periodObject(pair.txns, "h6");
  const txns24h = periodObject(pair.txns, "h24");

  return {
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    labels: pair.labels || [],
    baseToken: pair.baseToken,
    quoteToken: pair.quoteToken,
    priceUsd: Number(pair.priceUsd || 0),
    priceNative: Number(pair.priceNative || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0),
    liquidityBaseQuote: pair.liquidity || null,
    fdv: pair.fdv ?? null,
    marketCap: pair.marketCap ?? null,
    txns5m: {
      buys: Number(txns5m.buys || 0),
      sells: Number(txns5m.sells || 0),
    },
    txns1h: {
      buys: Number(txns1h.buys || 0),
      sells: Number(txns1h.sells || 0),
    },
    txns6h: {
      buys: Number(txns6h.buys || 0),
      sells: Number(txns6h.sells || 0),
    },
    txns24h: {
      buys: Number(txns24h.buys || 0),
      sells: Number(txns24h.sells || 0),
    },
    volume5m: Number(pair.volume?.m5 || 0),
    volume1h: Number(pair.volume?.h1 || 0),
    volume6h: Number(pair.volume?.h6 || 0),
    volume24h: Number(pair.volume?.h24 || 0),
    priceChange5m: Number(pair.priceChange?.m5 || 0),
    priceChange1h: Number(pair.priceChange?.h1 || 0),
    priceChange6h: Number(pair.priceChange?.h6 || 0),
    priceChange24h: Number(pair.priceChange?.h24 || 0),
    pairCreatedAt: pair.pairCreatedAt || null,
    socials: pair.info?.socials || [],
    websites: pair.info?.websites || [],
    imageUrl: pair.info?.imageUrl || null,
    header: pair.info?.header || null,
    boostsActive: Number(pair.boosts?.active || 0),
    url: pair.url,
    marketUpdatedAt: updatedAt,
  };
}
