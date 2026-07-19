// DEXScreener public API client. All data returned here is live market data.
const BASE = "https://api.dexscreener.com";

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`DEXScreener ${res.status} for ${url}`);
  return res.json();
}

// Latest token profiles (newly listed/updated tokens across chains).
export async function latestTokenProfiles() {
  const data = await getJson(`${BASE}/token-profiles/latest/v1`);
  return (Array.isArray(data) ? data : []).filter(t => t.chainId === "solana");
}

// Latest boosted tokens — teams that paid for DEXScreener boosts.
export async function latestBoosted() {
  const data = await getJson(`${BASE}/token-boosts/latest/v1`);
  return (Array.isArray(data) ? data : []).filter(t => t.chainId === "solana");
}

// Has the team paid for DEXScreener profile/boost? (financial commitment check)
export async function paidOrders(tokenAddress) {
  const data = await getJson(`${BASE}/orders/v1/solana/${tokenAddress}`);
  return Array.isArray(data) ? data : [];
}

// Live pairs for a token: price, liquidity, txns, volume, socials, age.
export async function tokenPairs(tokenAddress) {
  const data = await getJson(`${BASE}/latest/dex/tokens/${tokenAddress}`);
  return (data.pairs || []).filter(p => p.chainId === "solana");
}

// Pick the deepest pair for a token (primary market).
export function primaryPair(pairs) {
  if (!pairs?.length) return null;
  return [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

export function pairSnapshot(pair) {
  if (!pair) return null;
  return {
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    baseToken: pair.baseToken,
    priceUsd: Number(pair.priceUsd || 0),
    priceNative: Number(pair.priceNative || 0),
    liquidityUsd: pair.liquidity?.usd || 0,
    liquidityBaseQuote: pair.liquidity || null,
    fdv: pair.fdv || null,
    txns5m: pair.txns?.m5 || { buys: 0, sells: 0 },
    volume5m: pair.volume?.m5 || 0,
    volume1h: pair.volume?.h1 || 0,
    pairCreatedAt: pair.pairCreatedAt || null,
    socials: pair.info?.socials || [],
    websites: pair.info?.websites || [],
    url: pair.url,
  };
}
