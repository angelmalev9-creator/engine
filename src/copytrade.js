// Copytrading engine.
// One watcher per unique tracked wallet (deduplicated across all followers):
// polls getSignaturesForAddress every ~4s, parses new transactions, and
// detects swaps from the trader's token balance deltas. Detected buys are
// mirrored to every follower — but ONLY after the token passes the same
// anti-scam security gate as the sniper. Sells by the KOL close the
// followers' copied positions. FOMO-plan users get every event recorded as
// watch-only (executed=false) so the feed is identical, minus real money.
import { PublicKey } from "@solana/web3.js";
import { config, mergeSettings } from "./config.js";
import { kolscanLeaderboard } from "./kolscan.js";
import { withRpc } from "./rpc.js";
import { runSecurityGate } from "./security.js";
import { q } from "./supabase.js";
import { closePositionFor, marketSnapshot, openPositionFor } from "./trading.js";
import { balanceSol, ensureUserWallet } from "./wallets.js";

const SOL_LIKE = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

const watchers = new Map(); // address -> { lastSig, followers: Set<userId> }
const gateCache = new Map(); // mint -> { ts, pass, checks }
const GATE_TTL = 5 * 60_000;

export async function refreshWatchers() {
  // Union of: every user's manually tracked wallets + auto-follow of kolscan top N.
  const manual = await q.allActiveTraders();
  const kol = await kolscanLeaderboard();
  const users = await q.allProfiles();

  const followerMap = new Map(); // address -> Set(userId)
  const add = (addr, uid) => {
    if (!followerMap.has(addr)) followerMap.set(addr, new Set());
    followerMap.get(addr).add(uid);
  };
  for (const t of manual) add(t.address, t.user_id);
  for (const u of users) {
    const s = mergeSettings(await q.settings(u.id));
    if (!s.copytradeEnabled || !s.followKolscanTop) continue;
    for (const t of kol.slice(0, s.followKolscanTop)) add(t.address, u.id);
  }

  for (const addr of watchers.keys()) if (!followerMap.has(addr)) watchers.delete(addr);
  for (const [addr, followers] of followerMap) {
    if (!watchers.has(addr)) watchers.set(addr, { lastSig: null, followers });
    else watchers.get(addr).followers = followers;
  }
}

async function scamGateCached(mint) {
  const hit = gateCache.get(mint);
  if (hit && Date.now() - hit.ts < GATE_TTL) return hit;
  const res = await runSecurityGate(mint).catch(e => ({ pass: false, checks: { error: { pass: false, detail: e.message } } }));
  const entry = { ts: Date.now(), ...res };
  gateCache.set(mint, entry);
  return entry;
}

// Detect the trader's swap from balance deltas in a parsed transaction.
function detectSwap(tx, trader) {
  if (!tx?.meta || tx.meta.err) return null;
  const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
  const delta = new Map();
  for (const b of post) if (b.owner === trader) delta.set(b.mint, Number(b.uiTokenAmount.uiAmount || 0));
  for (const b of pre) if (b.owner === trader) delta.set(b.mint, (delta.get(b.mint) || 0) - Number(b.uiTokenAmount.uiAmount || 0));
  const moves = [...delta.entries()].filter(([mint, d]) => !SOL_LIKE.has(mint) && Math.abs(d) > 0);
  if (!moves.length) return null;
  const [mint, d] = moves.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  return { mint, side: d > 0 ? "buy" : "sell" };
}

export async function copytradeTick() {
  for (const [address, w] of watchers) {
    try {
      const sigs = await withRpc(c =>
        c.getSignaturesForAddress(new PublicKey(address), { limit: 8 }));
      if (!sigs.length) continue;
      const newest = sigs[0].signature;
      if (!w.lastSig) { w.lastSig = newest; continue; } // warm start: don't replay history
      const fresh = [];
      for (const s of sigs) { if (s.signature === w.lastSig) break; if (!s.err) fresh.push(s.signature); }
      w.lastSig = newest;

      for (const sig of fresh.reverse().slice(-3)) {
        const tx = await withRpc(c =>
          c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
        const swap = detectSwap(tx, address);
        if (swap) await mirrorToFollowers(address, sig, swap, w.followers);
      }
    } catch (e) { console.error(`watch ${address.slice(0, 6)}: ${e.message}`); }
  }
}

async function mirrorToFollowers(trader, traderSig, { mint, side }, followers) {
  const gate = side === "buy" ? await scamGateCached(mint) : null;
  const snap = await marketSnapshot(mint).catch(() => null);

  for (const userId of followers) {
    try {
      const profile = await q.profile(userId);
      const settings = mergeSettings(await q.settings(userId));
      if (!settings.copytradeEnabled) continue;

      let executed = false, blockReason = null, ourSig = null;

      if (side === "buy") {
        if (!gate.pass) blockReason = "failed scam gate";
        else if (profile.plan !== "pro") blockReason = "FOMO plan — watch only";
        else if (!config.liveTrading) blockReason = "engine in signal mode";
        else {
          const pk = await ensureUserWallet(userId);
          const bal = await balanceSol(pk).catch(() => 0);
          if (bal < settings.copySizeSol + 0.01) blockReason = "insufficient balance";
          else {
            const pos = await openPositionFor({
              userId, profile, settings, mint, snapshot: snap,
              source: "copytrade", copiedFrom: trader, sizeSol: settings.copySizeSol,
            });
            executed = !!pos?.buy_signature;
            ourSig = pos?.buy_signature || null;
            if (!pos) blockReason = "max positions / duplicate";
          }
        }
      } else {
        // KOL sold → close our copied position in that mint, if any.
        const positions = await q.userPositions(userId, 100);
        const open = positions.find(p => p.mint === mint && p.copied_from === trader && (p.status === "open" || p.status === "alert"));
        if (open) { await closePositionFor(open, `copytrade: ${trader.slice(0, 6)} sold`, snap); executed = open.status === "open"; }
        else blockReason = "no copied position";
      }

      await q.insertCopyEvent({
        user_id: userId, trader_address: trader, trader_signature: traderSig,
        side, mint, executed, block_reason: blockReason, our_signature: ourSig,
      });
    } catch (e) { console.error(`mirror ${userId}: ${e.message}`); }
  }
}
