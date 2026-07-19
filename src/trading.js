// Per-user trading core shared by the sniper and copytrader.
// Live positions use actual confirmed wallet balance deltas for accounting.
import { config, mergeSettings } from "./config.js";
import { pairSnapshot, paidOrders, primaryPair, tokenPairs } from "./dexscreener.js";
import { sellAll, buySol } from "./executor.js";
import { runSecurityGate } from "./security.js";
import { q } from "./supabase.js";
import { balanceSol, tokenBalances, userKeypair } from "./wallets.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function marketSnapshot(mint) {
  return pairSnapshot(primaryPair(await tokenPairs(mint)));
}

function toRaw(token) {
  if (!token) return 0;
  const raw = Number(token.amount) * (10 ** Number(token.decimals || 0));
  return Number.isFinite(raw) ? Math.round(raw) : 0;
}

async function walletSnapshot(publicKey, mint) {
  const [sol, tokens] = await Promise.all([
    balanceSol(publicKey),
    tokenBalances(publicKey),
  ]);
  const token = tokens.find(item => item.mint === mint) || null;
  return { sol, tokenRaw: toRaw(token), decimals: token?.decimals ?? null };
}

async function waitForWalletChange(publicKey, mint, before, direction) {
  let latest = before;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 250 : 500);
    latest = await walletSnapshot(publicKey, mint).catch(() => latest);
    const changed = direction === "buy"
      ? latest.tokenRaw > before.tokenRaw || latest.sol < before.sol
      : latest.tokenRaw < before.tokenRaw || latest.sol > before.sol;
    if (changed) return latest;
  }
  return latest;
}

// Full entry evaluation with market thresholds + the conservative security gate.
export async function evaluateToken(mint, entry) {
  const snap = await marketSnapshot(mint);
  const out = { mint, snapshot: snap, checks: {}, security: null, tradeReady: false };
  if (!snap) {
    out.checks.pair = { pass: false, detail: "No live Solana pair" };
    return out;
  }

  let liqSol = null;
  if (snap.liquidityUsd && snap.priceUsd && snap.priceNative) {
    liqSol = snap.liquidityUsd / (snap.priceUsd / snap.priceNative);
  }
  out.checks.liquidity = {
    pass: liqSol !== null && liqSol > entry.minLiquiditySol,
    detail: `pool ≈ ${liqSol?.toFixed?.(1) ?? "?"} SOL (min ${entry.minLiquiditySol})`,
  };

  const buys = snap.txns5m.buys || 0;
  const sells = snap.txns5m.sells || 0;
  const ratio = sells > 0 ? buys / sells : buys > 0 ? Infinity : 0;
  out.checks.velocity = {
    pass: buys + sells > entry.minTxns5m && ratio >= entry.minBuySellRatio,
    detail: `5m=${buys + sells} txns, b/s=${ratio === Infinity ? "∞" : ratio.toFixed(2)}`,
  };

  const twitter = snap.socials.find(s => /twitter|x\.com/i.test(`${s.type} ${s.url}`));
  out.checks.socials = {
    pass: !entry.requireSocials || Boolean(twitter),
    detail: twitter ? twitter.url : "no X account on listing",
  };

  if (entry.requireDexPaid) {
    try {
      const approved = (await paidOrders(mint)).filter(order => order.status === "approved");
      out.checks.dexPaid = { pass: approved.length > 0, detail: `${approved.length} paid order(s)` };
    } catch (e) {
      out.checks.dexPaid = { pass: false, detail: e.message };
    }
  } else {
    out.checks.dexPaid = { pass: true, detail: "disabled" };
  }

  if (Object.values(out.checks).every(check => check.pass)) {
    out.security = await runSecurityGate(mint, { primaryPairAddress: snap.pairAddress });
    out.tradeReady = out.security.pass;
  }
  return out;
}

// Manual verdict. "scam-risk" means one or more checks failed or were unverifiable.
export async function scamCheck(mint) {
  const snap = await marketSnapshot(mint).catch(() => null);
  const sec = await runSecurityGate(mint, { primaryPairAddress: snap?.pairAddress || null });
  return {
    mint,
    verdict: sec.pass ? "real" : "scam-risk",
    checks: sec.checks,
  };
}

function userIsLive(profile) {
  return config.liveTrading && profile.plan === "pro";
}

export async function openPositionFor({ userId, profile, settings, mint, snapshot, source, copiedFrom, sizeSol }) {
  const open = (await q.userPositions(userId, 100))
    .filter(position => position.status === "open" || position.status === "alert");
  if (open.length >= settings.maxOpenPositions || open.some(position => position.mint === mint)) {
    return null;
  }

  const live = userIsLive(profile);
  let result = { signature: null, quote: null, dryRun: true };
  let actualSpentSol = Number(sizeSol);
  let actualTokenRaw = 0;

  if (live) {
    const keypair = await userKeypair(userId);
    const publicKey = keypair.publicKey.toBase58();
    const before = await walletSnapshot(publicKey, mint);

    result = await buySol(keypair, mint, sizeSol, settings.slippageBps, false);
    const after = await waitForWalletChange(publicKey, mint, before, "buy");

    const measuredSpent = before.sol - after.sol;
    const measuredTokens = after.tokenRaw - before.tokenRaw;
    if (measuredSpent > 0) actualSpentSol = measuredSpent;
    if (measuredTokens > 0) actualTokenRaw = measuredTokens;
  } else {
    try {
      result = await buySol(null, mint, sizeSol, settings.slippageBps, true);
    } catch {
      // Quote is optional in alert mode. No fake signature is created.
    }
  }

  if (!actualTokenRaw) actualTokenRaw = Number(result.quote?.outAmount || 0);

  const position = await q.insertPosition({
    user_id: userId,
    status: result.signature ? "open" : "alert",
    source,
    copied_from: copiedFrom || null,
    mint,
    symbol: snapshot?.baseToken?.symbol || mint.slice(0, 6),
    entry_sol: actualSpentSol,
    entry_price_usd: snapshot?.priceUsd ?? null,
    token_amount_raw: actualTokenRaw,
    peak_price_usd: snapshot?.priceUsd ?? null,
    entry_volume_5m: snapshot?.volume5m ?? null,
    buy_signature: result.signature,
  });

  if (result.signature) {
    await q.insertTx({
      user_id: userId,
      type: "buy",
      signature: result.signature,
      mint,
      sol_amount: -actualSpentSol,
      token_amount: actualTokenRaw,
    });
  }
  return position;
}

export async function closePositionFor(position, reason, snapshot) {
  let signature = null;
  let actualSolOut = null;
  let actualTokenSold = null;
  let reconciliationReason = reason;

  if (position.status === "open") {
    const profile = await q.profile(position.user_id);
    const settings = mergeSettings(await q.settings(position.user_id));
    const keypair = await userKeypair(position.user_id);
    const publicKey = keypair.publicKey.toBase58();
    const before = await walletSnapshot(publicKey, position.mint);
    const rawToSell = before.tokenRaw > 0 ? before.tokenRaw : Number(position.token_amount_raw || 0);

    if (before.tokenRaw <= 0) {
      // The bot cannot claim a sale it did not observe. This usually means the
      // tokens were moved or sold outside Emerald Gate.
      reconciliationReason = `${reason}; token balance missing — external movement suspected`;
    } else if (rawToSell > 0) {
      const live = userIsLive(profile);
      if (!live) {
        throw new Error("Live sell is disabled or the account is not PRO; position kept open");
      }
      const result = await sellAll(keypair, position.mint, rawToSell, settings.slippageBps, false);
      signature = result.signature;

      if (signature) {
        const after = await waitForWalletChange(publicKey, position.mint, before, "sell");
        const measuredOut = after.sol - before.sol;
        const measuredSold = before.tokenRaw - after.tokenRaw;
        actualSolOut = measuredOut > 0 ? measuredOut : null;
        actualTokenSold = measuredSold > 0 ? measuredSold : rawToSell;
      } else {
        actualSolOut = result.quote ? Number(result.quote.outAmount) / 1e9 : null;
        actualTokenSold = rawToSell;
      }
    }
  }

  const exitPrice = snapshot?.priceUsd ?? position.entry_price_usd;
  const entrySol = Number(position.entry_sol || 0);
  const marketPnlPct = position.entry_price_usd
    ? ((Number(exitPrice) - Number(position.entry_price_usd)) / Number(position.entry_price_usd)) * 100
    : null;
  const actualPnlSol = actualSolOut !== null && entrySol > 0 ? actualSolOut - entrySol : null;
  const actualPnlPct = actualPnlSol !== null && entrySol > 0 ? (actualPnlSol / entrySol) * 100 : null;

  await q.updatePosition(position.id, {
    status: "closed",
    closed_at: new Date(),
    exit_price_usd: exitPrice,
    sell_signature: signature,
    exit_reason: reconciliationReason,
    pnl_pct: actualPnlPct ?? marketPnlPct,
    pnl_sol: actualPnlSol,
  });

  if (signature) {
    await q.insertTx({
      user_id: position.user_id,
      type: "sell",
      signature,
      mint: position.mint,
      sol_amount: actualSolOut,
      token_amount: -Number(actualTokenSold ?? position.token_amount_raw ?? 0),
    });
  }
}

// Exit engine — runs over every active position of every user.
export async function manageAllPositions() {
  const positions = await q.allActivePositions();
  const byMint = new Map();
  for (const position of positions) {
    if (!byMint.has(position.mint)) byMint.set(position.mint, []);
    byMint.get(position.mint).push(position);
  }

  for (const [mint, group] of byMint) {
    let snap;
    try {
      snap = await marketSnapshot(mint);
    } catch {
      continue;
    }
    if (!snap?.priceUsd) continue;

    for (const position of group) {
      try {
        const exit = mergeSettings(await q.settings(position.user_id)).exit;
        const entry = Number(position.entry_price_usd) || snap.priceUsd;
        const changePct = ((snap.priceUsd - entry) / entry) * 100;
        const peak = Math.max(Number(position.peak_price_usd) || snap.priceUsd, snap.priceUsd);
        const peakGain = ((peak - entry) / entry) * 100;
        const dropFromPeak = ((peak - snap.priceUsd) / peak) * 100;

        await q.updatePosition(position.id, {
          peak_price_usd: peak,
          last_price_usd: snap.priceUsd,
          last_change_pct: changePct,
        });

        const ageMin = (Date.now() - new Date(position.opened_at).getTime()) / 60000;
        if (changePct <= exit.hardSlPct) {
          await closePositionFor(position, `hard SL ${exit.hardSlPct}%`, snap);
        } else if (peakGain >= exit.trailArmPct && dropFromPeak >= exit.trailDropPct) {
          await closePositionFor(position, `trailing TP (peak +${peakGain.toFixed(0)}%)`, snap);
        } else if (
          Number(position.entry_volume_5m) > 0 &&
          ((Number(position.entry_volume_5m) - snap.volume5m) / Number(position.entry_volume_5m)) * 100 > exit.volumeDryupPct
        ) {
          await closePositionFor(position, "volume dry-up", snap);
        } else if (ageMin >= exit.maxHoldMinutes && peakGain < exit.baseTpPct) {
          await closePositionFor(position, `time exit ${exit.maxHoldMinutes}m`, snap);
        }
      } catch (e) {
        console.error(`exit ${position.id}: ${e.message}`);
      }
    }
  }
}
