// Conservative copytrading engine.
// A transaction is copied only when it contains swap/buy/sell program evidence
// AND an opposite quote-asset flow (SOL/WSOL/USDC/USDT) for the tracked wallet.
import { PublicKey } from "@solana/web3.js";
import { config, mergeSettings } from "./config.js";
import { kolscanLeaderboard } from "./kolscan.js";
import { withRpc } from "./rpc.js";
import { runSecurityGate } from "./security.js";
import { q } from "./supabase.js";
import { closePositionFor, marketSnapshot, openPositionFor } from "./trading.js";
import { balanceSol, ensureUserWallet } from "./wallets.js";

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const EPS = 1e-12;
const MIN_NATIVE_FLOW_SOL = 0.00001;
const GATE_TTL = 5 * 60_000;
const SIGNATURE_TTL = 30 * 60_000;

const watchers = new Map(); // address -> { lastSig, followers }
const gateCache = new Map(); // mint:pair -> result
const processed = new Map(); // address:signature -> timestamp

function keyString(key) {
  if (typeof key === "string") return key;
  if (typeof key?.pubkey === "string") return key.pubkey;
  if (typeof key?.pubkey?.toBase58 === "function") return key.pubkey.toBase58();
  if (typeof key?.toBase58 === "function") return key.toBase58();
  return String(key || "");
}

function ownerString(owner) {
  if (typeof owner === "string") return owner;
  if (typeof owner?.toBase58 === "function") return owner.toBase58();
  return String(owner || "");
}

function uiAmount(balance) {
  const value = balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hasSwapInstruction(tx) {
  const logs = (tx?.meta?.logMessages || []).join("\n");
  return /instruction:\s*(swap|buy|sell)\b|\bswap\b|ray_log/i.test(logs);
}

function tokenDeltas(tx, trader) {
  const delta = new Map();
  for (const balance of tx.meta?.postTokenBalances || []) {
    if (ownerString(balance.owner) !== trader) continue;
    delta.set(balance.mint, (delta.get(balance.mint) || 0) + uiAmount(balance));
  }
  for (const balance of tx.meta?.preTokenBalances || []) {
    if (ownerString(balance.owner) !== trader) continue;
    delta.set(balance.mint, (delta.get(balance.mint) || 0) - uiAmount(balance));
  }
  return delta;
}

function nativeSolDelta(tx, trader) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const index = keys.findIndex(key => keyString(key) === trader);
  if (index < 0) return 0;

  const pre = Number(tx.meta?.preBalances?.[index] || 0);
  const post = Number(tx.meta?.postBalances?.[index] || 0);
  // The first account is normally the fee payer. Add the fee back so the value
  // represents trade flow rather than network cost.
  const feeAdjustment = index === 0 ? Number(tx.meta?.fee || 0) : 0;
  return (post - pre + feeAdjustment) / 1e9;
}

// Returns one verified target movement. Ambiguous multi-token movements,
// transfers and airdrops are ignored instead of being mislabeled as swaps.
function detectVerifiedSwap(tx, trader) {
  if (!tx?.meta || tx.meta.err || !hasSwapInstruction(tx)) return null;

  const deltas = tokenDeltas(tx, trader);
  const targetMoves = [...deltas.entries()]
    .filter(([mint, delta]) => !QUOTE_MINTS.has(mint) && Math.abs(delta) > EPS);

  if (targetMoves.length !== 1) return null;

  const [mint, targetDelta] = targetMoves[0];
  const nativeDelta = nativeSolDelta(tx, trader);
  const quoteDeltas = [...deltas.entries()]
    .filter(([quoteMint]) => QUOTE_MINTS.has(quoteMint))
    .map(([, delta]) => delta);

  const quoteOut = nativeDelta < -MIN_NATIVE_FLOW_SOL || quoteDeltas.some(delta => delta < -EPS);
  const quoteIn = nativeDelta > MIN_NATIVE_FLOW_SOL || quoteDeltas.some(delta => delta > EPS);

  if (targetDelta > 0 && quoteOut) {
    return { mint, side: "buy", targetDelta, nativeDelta, verified: true };
  }
  if (targetDelta < 0 && quoteIn) {
    return { mint, side: "sell", targetDelta, nativeDelta, verified: true };
  }
  return null;
}

function pruneProcessed() {
  const cutoff = Date.now() - SIGNATURE_TTL;
  for (const [key, ts] of processed) if (ts < cutoff) processed.delete(key);
}

export async function refreshWatchers() {
  const manual = await q.allActiveTraders();
  const kol = await kolscanLeaderboard();
  const users = await q.allProfiles();

  const followerMap = new Map();
  const add = (address, userId) => {
    if (!followerMap.has(address)) followerMap.set(address, new Set());
    followerMap.get(address).add(userId);
  };

  for (const trader of manual) add(trader.address, trader.user_id);
  for (const user of users) {
    const settings = mergeSettings(await q.settings(user.id));
    if (!settings.copytradeEnabled || !settings.followKolscanTop) continue;
    for (const trader of kol.slice(0, settings.followKolscanTop)) add(trader.address, user.id);
  }

  for (const address of watchers.keys()) {
    if (!followerMap.has(address)) watchers.delete(address);
  }
  for (const [address, followers] of followerMap) {
    if (!watchers.has(address)) watchers.set(address, { lastSig: null, followers });
    else watchers.get(address).followers = followers;
  }
}

async function scamGateCached(mint, primaryPairAddress) {
  const key = `${mint}:${primaryPairAddress || "unknown"}`;
  const hit = gateCache.get(key);
  if (hit && Date.now() - hit.ts < GATE_TTL) return hit;

  const result = await runSecurityGate(mint, { primaryPairAddress }).catch(error => ({
    pass: false,
    checks: { error: { pass: false, detail: error.message } },
  }));
  const entry = { ts: Date.now(), ...result };
  gateCache.set(key, entry);
  return entry;
}

export async function copytradeTick() {
  pruneProcessed();

  for (const [address, watcher] of watchers) {
    try {
      const signatures = await withRpc(connection =>
        connection.getSignaturesForAddress(new PublicKey(address), { limit: 50 })
      );
      if (!signatures.length) continue;

      const newest = signatures[0].signature;
      if (!watcher.lastSig) {
        watcher.lastSig = newest;
        continue; // warm start: never replay historical trades
      }

      const fresh = [];
      for (const item of signatures) {
        if (item.signature === watcher.lastSig) break;
        if (!item.err) fresh.push(item.signature);
      }
      watcher.lastSig = newest;

      for (const signature of fresh.reverse().slice(-10)) {
        const dedupeKey = `${address}:${signature}`;
        if (processed.has(dedupeKey)) continue;
        processed.set(dedupeKey, Date.now());

        const tx = await withRpc(connection =>
          connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
        );
        const swap = detectVerifiedSwap(tx, address);
        if (swap) await mirrorToFollowers(address, signature, swap, watcher.followers);
      }
    } catch (e) {
      console.error(`watch ${address.slice(0, 6)}: ${e.message}`);
    }
  }
}

async function mirrorToFollowers(trader, traderSignature, { mint, side }, followers) {
  const snap = await marketSnapshot(mint).catch(() => null);
  const gate = side === "buy"
    ? await scamGateCached(mint, snap?.pairAddress || null)
    : null;

  for (const userId of followers) {
    try {
      const profile = await q.profile(userId);
      const settings = mergeSettings(await q.settings(userId));
      if (!settings.copytradeEnabled) continue;

      let executed = false;
      let blockReason = null;
      let ourSignature = null;

      if (side === "buy") {
        if (!snap) blockReason = "no live primary market pair";
        else if (!gate.pass) blockReason = "failed security gate";
        else if (profile.plan !== "pro") blockReason = "FOMO plan — watch only";
        else if (!config.liveTrading) blockReason = "engine in signal mode";
        else {
          const publicKey = await ensureUserWallet(userId);
          const balance = await balanceSol(publicKey).catch(() => 0);
          if (balance < settings.copySizeSol + 0.01) {
            blockReason = "insufficient balance";
          } else {
            const position = await openPositionFor({
              userId,
              profile,
              settings,
              mint,
              snapshot: snap,
              source: "copytrade",
              copiedFrom: trader,
              sizeSol: settings.copySizeSol,
            });
            executed = Boolean(position?.buy_signature);
            ourSignature = position?.buy_signature || null;
            if (!position) blockReason = "max positions / duplicate";
          }
        }
      } else {
        const positions = await q.userPositions(userId, 100);
        const open = positions.find(position =>
          position.mint === mint &&
          position.copied_from === trader &&
          (position.status === "open" || position.status === "alert")
        );

        if (open) {
          await closePositionFor(open, `copytrade: ${trader.slice(0, 6)} sold`, snap);
          executed = open.status === "open";
        } else {
          blockReason = "no copied position";
        }
      }

      await q.insertCopyEvent({
        user_id: userId,
        trader_address: trader,
        trader_signature: traderSignature,
        side,
        mint,
        executed,
        block_reason: blockReason,
        our_signature: ourSignature,
      });
    } catch (e) {
      console.error(`mirror ${userId}: ${e.message}`);
    }
  }
}
