// Anti-rug security gate. Every check reads real on-chain state or the live
// Rugcheck report. A token must pass 100% of checks to clear the gate.
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { withRpc } from "./rpc.js";

// 1) Mint + freeze authority must both be disabled (renounced).
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

// 2) Top-10 holder concentration from getTokenLargestAccounts vs total supply.
//    Bonding-curve / pool / exchange vaults are excluded via Rugcheck's
//    ownership map when available; otherwise the largest single account
//    (typically the pool vault) is excluded.
export async function checkTopHolders(mintAddress, rugcheckReport) {
  const mint = new PublicKey(mintAddress);
  const [largest, supplyRes] = await Promise.all([
    withRpc(c => c.getTokenLargestAccounts(mint, "confirmed")),
    withRpc(c => c.getTokenSupply(mint, "confirmed")),
  ]);
  const total = Number(supplyRes.value.uiAmount || 0);
  if (!total) return { pass: false, detail: "Zero or unreadable supply" };

  const knownVaults = new Set(
    (rugcheckReport?.markets || [])
      .flatMap(m => [m.liquidityA, m.liquidityB, m.pubkey])
      .filter(Boolean)
  );

  let accounts = largest.value.map(a => ({
    address: a.address.toBase58 ? a.address.toBase58() : String(a.address),
    ui: Number(a.uiAmount || 0),
  }));
  let filtered = accounts.filter(a => !knownVaults.has(a.address));
  if (filtered.length === accounts.length && filtered.length > 0) {
    // No vault metadata — drop the single largest account as the presumed pool vault.
    filtered = [...filtered].sort((a, b) => b.ui - a.ui).slice(1);
  }
  const top10 = filtered.slice(0, 10).reduce((s, a) => s + a.ui, 0);
  const pct = (top10 / total) * 100;
  return {
    pass: pct < config.security.maxTop10HolderPct,
    detail: `top10=${pct.toFixed(2)}% (limit ${config.security.maxTop10HolderPct}%)`,
    pct,
  };
}

// 3+4) Rugcheck live report: normalized risk score and LP lock/burn percentage.
export async function fetchRugcheck(mintAddress) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Rugcheck ${res.status}`);
  return res.json();
}

export function checkRugScore(report) {
  const score = report?.score_normalised ?? report?.score ?? null;
  if (score === null) return { pass: false, detail: "No Rugcheck score available" };
  return {
    pass: score < config.security.maxRugcheckScore,
    detail: `rugcheck=${score}/100 (limit <${config.security.maxRugcheckScore})`,
    score,
  };
}

export function checkLpLocked(report) {
  const markets = report?.markets || [];
  if (!markets.length) return { pass: false, detail: "No market/LP data in Rugcheck report" };
  // Take the primary (largest) market's LP locked+burned percentage.
  const best = markets
    .map(m => Number(m?.lp?.lpLockedPct ?? 0))
    .sort((a, b) => b - a)[0];
  return {
    pass: best >= config.security.minLpLockedPct,
    detail: `LP locked/burned=${best?.toFixed?.(1) ?? best}% (min ${config.security.minLpLockedPct}%)`,
    pct: best,
  };
}

// Run the full gate. Returns { pass, checks: {...} }.
export async function runSecurityGate(mintAddress) {
  const checks = {};
  let report = null;
  try {
    report = await fetchRugcheck(mintAddress);
  } catch (e) {
    checks.rugcheck = { pass: false, detail: `Rugcheck unavailable: ${e.message}` };
  }

  const [auth, holders] = await Promise.all([
    checkAuthorities(mintAddress).catch(e => ({ pass: false, detail: e.message })),
    checkTopHolders(mintAddress, report).catch(e => ({ pass: false, detail: e.message })),
  ]);
  checks.authorities = auth;
  checks.topHolders = holders;
  if (report) {
    checks.rugcheck = checkRugScore(report);
    checks.lpLocked = checkLpLocked(report);
  } else {
    checks.lpLocked = { pass: false, detail: "Rugcheck unavailable — cannot verify LP lock" };
  }

  const pass = Object.values(checks).every(c => c.pass);
  return { pass, checks };
}
