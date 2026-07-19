// Per-user trading core shared by the sniper and the copytrader.
import { config, mergeSettings } from "./config.js";
import { pairSnapshot, paidOrders, primaryPair, tokenPairs } from "./dexscreener.js";
import { sellAll, buySol } from "./executor.js";
import { runSecurityGate } from "./security.js";
import { q } from "./supabase.js";
import { tokenBalances, userKeypair } from "./wallets.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function marketSnapshot(mint) {
  return pairSnapshot(primaryPair(await tokenPairs(mint)));
}

// Full entry evaluation with global security gate + default entry thresholds.
export async function evaluateToken(mint, entry) {
  const snap = await marketSnapshot(mint);
  const out = { mint, snapshot: snap, checks: {}, security: null, tradeReady: false };
  if (!snap) { out.checks.pair = { pass: false, detail: "No live Solana pair" }; return out; }

  let liqSol = null;
  if (snap.liquidityUsd && snap.priceUsd && snap.priceNative) {
    liqSol = snap.liquidityUsd / (snap.priceUsd / snap.priceNative);
  }
  out.checks.liquidity = {
    pass: liqSol !== null && liqSol > entry.minLiquiditySol,
    detail: `pool ≈ ${liqSol?.toFixed?.(1) ?? "?"} SOL (min ${entry.minLiquiditySol})`,
  };

  const buys = snap.txns5m.buys || 0, sells = snap.txns5m.sells || 0;
  const ratio = sells > 0 ? buys / sells : buys > 0 ? Infinity : 0;
  out.checks.velocity = {
    pass: buys + sells > entry.minTxns5m && ratio >= entry.minBuySellRatio,
    detail: `5m=${buys + sells} txns, b/s=${ratio === Infinity ? "∞" : ratio.toFixed(2)}`,
  };

  const tw = snap.socials.find(s => /twitter|x\.com/i.test(`${s.type} ${s.url}`));
  out.checks.socials = { pass: !entry.requireSocials || !!tw, detail: tw ? tw.url : "no X account on listing" };

  if (entry.requireDexPaid) {
    try {
      const approved = (await paidOrders(mint)).filter(o => o.status === "approved");
      out.checks.dexPaid = { pass: approved.length > 0, detail: `${approved.length} paid order(s)` };
    } catch (e) { out.checks.dexPaid = { pass: false, detail: e.message }; }
  } else out.checks.dexPaid = { pass: true, detail: "disabled" };

  if (Object.values(out.checks).every(c => c.pass)) {
    out.security = await runSecurityGate(mint);
    out.tradeReady = out.security.pass;
  }
  return out;
}

// Scam-or-real verdict for any token (also exposed via API for manual checks).
export async function scamCheck(mint) {
  const sec = await runSecurityGate(mint);
  return { mint, verdict: sec.pass ? "real" : "scam-risk", checks: sec.checks };
}

async function userIsLive(profile) {
  return config.liveTrading && profile.plan === "pro";
}

export async function openPositionFor({ userId, profile, settings, mint, snapshot, source, copiedFrom, sizeSol }) {
  const s = settings;
  const open = (await q.userPositions(userId, 100)).filter(p => p.status === "open" || p.status === "alert");
  if (open.length >= s.maxOpenPositions || open.some(p => p.mint === mint && p.status !== "closed")) return null;

  const live = await userIsLive(profile);
  let res = { signature: null, quote: null, dryRun: true };
  if (live) {
    const kp = await userKeypair(userId);
    res = await buySol(kp, mint, sizeSol, s.slippageBps, false);
  } else {
    try { res = await buySol(null, mint, sizeSol, s.slippageBps, true); } catch { /* quote optional in alert mode */ }
  }

  const pos = await q.insertPosition({
    user_id: userId,
    status: res.signature ? "open" : "alert",
    source, copied_from: copiedFrom || null,
    mint, symbol: snapshot?.baseToken?.symbol || mint.slice(0, 6),
    entry_sol: sizeSol,
    entry_price_usd: snapshot?.priceUsd ?? null,
    token_amount_raw: Number(res.quote?.outAmount || 0),
    peak_price_usd: snapshot?.priceUsd ?? null,
    entry_volume_5m: snapshot?.volume5m ?? null,
    buy_signature: res.signature,
  });
  if (res.signature) {
    await q.insertTx({ user_id: userId, type: "buy", signature: res.signature, mint, sol_amount: -sizeSol, token_amount: pos.token_amount_raw });
  }
  return pos;
}

export async function closePositionFor(pos, reason, snapshot) {
  let sig = null, solOut = null;
  if (pos.status === "open") {
    const profile = await q.profile(pos.user_id);
    const settings = mergeSettings(await q.settings(pos.user_id));
    const kp = await userKeypair(pos.user_id);
    const held = (await tokenBalances(kp.publicKey.toBase58()).catch(() => []))
      .find(b => b.mint === pos.mint);
    const raw = held ? Math.floor(held.amount * 10 ** held.decimals) : Number(pos.token_amount_raw);
    if (raw > 0) {
      const live = await userIsLive(profile);
      const res = await sellAll(kp, pos.mint, raw, settings.slippageBps, !live);
      sig = res.signature;
      solOut = res.quote ? Number(res.quote.outAmount) / 1e9 : null;
    }
  }
  const exitPrice = snapshot?.priceUsd ?? pos.entry_price_usd;
  const pnlPct = pos.entry_price_usd ? ((exitPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100 : null;
  await q.updatePosition(pos.id, {
    status: "closed", closed_at: new Date(), exit_price_usd: exitPrice,
    sell_signature: sig, exit_reason: reason, pnl_pct: pnlPct,
    pnl_sol: solOut !== null ? solOut - Number(pos.entry_sol) : null,
  });
  if (sig) await q.insertTx({ user_id: pos.user_id, type: "sell", signature: sig, mint: pos.mint, sol_amount: solOut, token_amount: -Number(pos.token_amount_raw) });
}

// Exit engine — runs over every active position of every user.
export async function manageAllPositions() {
  const positions = await q.allActivePositions();
  const byMint = new Map();
  for (const p of positions) {
    if (!byMint.has(p.mint)) byMint.set(p.mint, []);
    byMint.get(p.mint).push(p);
  }
  for (const [mint, group] of byMint) {
    let snap;
    try { snap = await marketSnapshot(mint); } catch { continue; }
    if (!snap?.priceUsd) continue;
    for (const pos of group) {
      try {
        const x = mergeSettings(await q.settings(pos.user_id)).exit;
        const entry = Number(pos.entry_price_usd) || snap.priceUsd;
        const changePct = ((snap.priceUsd - entry) / entry) * 100;
        const peak = Math.max(Number(pos.peak_price_usd) || snap.priceUsd, snap.priceUsd);
        const peakGain = ((peak - entry) / entry) * 100;
        const dropFromPeak = ((peak - snap.priceUsd) / peak) * 100;
        await q.updatePosition(pos.id, { peak_price_usd: peak, last_price_usd: snap.priceUsd, last_change_pct: changePct });

        const ageMin = (Date.now() - new Date(pos.opened_at).getTime()) / 60000;
        if (changePct <= x.hardSlPct) await closePositionFor(pos, `hard SL ${x.hardSlPct}%`, snap);
        else if (peakGain >= x.trailArmPct && dropFromPeak >= x.trailDropPct)
          await closePositionFor(pos, `trailing TP (peak +${peakGain.toFixed(0)}%)`, snap);
        else if (Number(pos.entry_volume_5m) > 0 && ((Number(pos.entry_volume_5m) - snap.volume5m) / Number(pos.entry_volume_5m)) * 100 > x.volumeDryupPct)
          await closePositionFor(pos, "volume dry-up", snap);
        else if (ageMin >= x.maxHoldMinutes && peakGain < x.baseTpPct)
          await closePositionFor(pos, `time exit ${x.maxHoldMinutes}m`, snap);
      } catch (e) { console.error(`exit ${pos.id}: ${e.message}`); }
    }
  }
}
