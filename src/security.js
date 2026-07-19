// Conservative anti-rug gate. Every pass is backed by live on-chain state
// or a Rugcheck report. Missing or ambiguous data fails closed.
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { withRpc } from "./rpc.js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function asAddress(value) {
  if (!value) return null;
  if (typeof value === "string") return BASE58_RE.test(value) ? value : null;
  if (typeof value?.toBase58 === "function") return value.toBase58();
  if (typeof value === "object") {
    for (const key of ["address", "pubkey", "tokenAccount", "vault", "ata"]) {
      const found = asAddress(value[key]);
      if (found) return found;
    }
  }
  return null;
}

function marketAddresses(market) {
  const out = new Set();
  for (const value of [
    market?.pubkey,
    market?.address,
    market?.market,
    market?.marketId,
    market?.pairAddress,
    market?.id,
  ]) {
    const address = asAddress(value);
    if (address) out.add(address);
  }
  return out;
}

function marketVaultAddresses(market) {
  const out = new Set();
  for (const value of [
    market?.liquidityA,
    market?.liquidityB,
    market?.vaultA,
    market?.vaultB,
    market?.baseVault,
    market?.quoteVault,
    market?.tokenAccountA,
    market?.tokenAccountB,
  ]) {
    const address = asAddress(value);
    if (address) out.add(address);
  }
  return out;
}

function lpLockedPct(market) {
  const direct = Number(market?.lp?.lpLockedPct ?? market?.lpLockedPct);
  if (Number.isFinite(direct)) return direct;

  const locked = Number(market?.lp?.lpLocked ?? market?.lpLocked);
  const total = Number(market?.lp?.lpTotal ?? market?.lpTotal);
  if (Number.isFinite(locked) && Number.isFinite(total) && total > 0) {
    return (locked / total) * 100;
  }
  return null;
}

// 1) Mint + freeze authority must both be disabled.
export async function checkAuthorities(mintAddress) {
  const info = await withRpc(c =>
    c.getParsedAccountInfo(new PublicKey(mintAddress), "confirmed")
  );
  const parsed = info.value?.data?.parsed?.info;
  if (!parsed) return { pass: false, detail: "Mint account not readable on-chain" };

  const mintAuth = parsed.mintAuthority ?? null;
  const freezeAuth = parsed.freezeAuthority ?? null;
  return {
    pass: mintAuth === null && freezeAuth === null,
    detail: `mintAuthority=${mintAuth ?? "disabled"} freezeAuthority=${freezeAuth ?? "disabled"}`,
    supply: parsed.supply,
    decimals: parsed.decimals,
  };
}

// 2) Top-10 holder concentration. Only vaults explicitly identified by
// Rugcheck are excluded. We never guess that the largest account is a pool.
export async function checkTopHolders(mintAddress, rugcheckReport) {
  const mint = new PublicKey(mintAddress);
  const [largest, supplyRes] = await Promise.all([
    withRpc(c => c.getTokenLargestAccounts(mint, "confirmed")),
    withRpc(c => c.getTokenSupply(mint, "confirmed")),
  ]);

  const total = Number(supplyRes.value.uiAmount || 0);
  if (!total) return { pass: false, detail: "Zero or unreadable supply" };

  const knownVaults = new Set();
  for (const market of rugcheckReport?.markets || []) {
    for (const address of marketVaultAddresses(market)) knownVaults.add(address);
  }

  const accounts = largest.value
    .map(a => ({
      address: typeof a.address?.toBase58 === "function" ? a.address.toBase58() : String(a.address),
      ui: Number(a.uiAmount || 0),
    }))
    .filter(a => a.ui > 0 && !knownVaults.has(a.address))
    .sort((a, b) => b.ui - a.ui);

  const top10 = accounts.slice(0, 10).reduce((sum, account) => sum + account.ui, 0);
  const pct = (top10 / total) * 100;
  return {
    pass: pct < config.security.maxTop10HolderPct,
    detail: `top10=${pct.toFixed(2)}% (limit ${config.security.maxTop10HolderPct}%; excluded ${knownVaults.size} verified vaults)`,
    pct,
    excludedVaults: knownVaults.size,
  };
}

// 3+4) Rugcheck report: risk score and LP lock for the actual primary pair.
export async function fetchRugcheck(mintAddress) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Rugcheck ${res.status}`);
  return res.json();
}

export function checkRugScore(report) {
  const score = Number(report?.score_normalised ?? report?.score);
  if (!Number.isFinite(score)) return { pass: false, detail: "No Rugcheck score available" };
  return {
    pass: score < config.security.maxRugcheckScore,
    detail: `rugcheck=${score}/100 (limit <${config.security.maxRugcheckScore})`,
    score,
  };
}

export function checkLpLocked(report, primaryPairAddress = null) {
  const markets = Array.isArray(report?.markets) ? report.markets : [];
  if (!markets.length) return { pass: false, detail: "No market/LP data in Rugcheck report" };

  let market = null;
  if (primaryPairAddress) {
    market = markets.find(item => marketAddresses(item).has(primaryPairAddress)) || null;
    if (!market) {
      return {
        pass: false,
        detail: `Rugcheck market does not match primary pair ${primaryPairAddress.slice(0, 6)}…`,
      };
    }
  } else if (markets.length === 1) {
    market = markets[0];
  } else {
    return {
      pass: false,
      detail: "Multiple markets found but primary pair could not be verified",
    };
  }

  const pct = lpLockedPct(market);
  if (!Number.isFinite(pct)) {
    return { pass: false, detail: "LP lock percentage unavailable for primary pair" };
  }

  return {
    pass: pct >= config.security.minLpLockedPct,
    detail: `primary-pair LP locked/burned=${pct.toFixed(1)}% (min ${config.security.minLpLockedPct}%)`,
    pct,
  };
}

// Returns { pass, checks }. Any unavailable or ambiguous check fails closed.
export async function runSecurityGate(mintAddress, { primaryPairAddress = null } = {}) {
  const checks = {};
  let report = null;

  try {
    report = await fetchRugcheck(mintAddress);
  } catch (e) {
    checks.rugcheck = { pass: false, detail: `Rugcheck unavailable: ${e.message}` };
  }

  const [authorities, holders] = await Promise.all([
    checkAuthorities(mintAddress).catch(e => ({ pass: false, detail: e.message })),
    checkTopHolders(mintAddress, report).catch(e => ({ pass: false, detail: e.message })),
  ]);

  checks.authorities = authorities;
  checks.topHolders = holders;

  if (report) {
    checks.rugcheck = checkRugScore(report);
    checks.lpLocked = checkLpLocked(report, primaryPairAddress);
  } else {
    checks.lpLocked = { pass: false, detail: "Rugcheck unavailable — cannot verify primary LP" };
  }

  return { pass: Object.values(checks).every(check => check.pass), checks };
}
