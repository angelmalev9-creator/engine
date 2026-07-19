// Jupiter v6 execution, parameterized per user keypair. dryRun=true never signs.
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { withRpc } from "./rpc.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://quote-api.jup.ag/v6";

export async function dynamicPriorityFee() {
  try {
    const fees = await withRpc(c => c.getRecentPrioritizationFees());
    const v = fees.map(f => f.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    if (!v.length) return 50_000;
    return Math.min(Math.max(v[Math.floor(v.length * 0.75)] * 2, 50_000), 2_000_000);
  } catch { return 100_000; }
}

async function quote(inputMint, outputMint, amount, slippageBps) {
  const r = await fetch(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
  if (!r.ok) throw new Error(`Jupiter quote ${r.status}`);
  return r.json();
}

async function swapTx(quoteResponse, userPublicKey, fee) {
  const r = await fetch(`${JUP}/swap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse, userPublicKey, wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true, computeUnitPriceMicroLamports: fee,
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap ${r.status}`);
  return VersionedTransaction.deserialize(Buffer.from((await r.json()).swapTransaction, "base64"));
}

async function broadcast(tx, keypair) {
  tx.sign([keypair]);
  if (config.jito.enabled) {
    try {
      const r = await fetch(`${config.jito.blockEngine}/api/v1/transactions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [bs58.encode(tx.serialize())] }),
      });
      const j = await r.json();
      if (!j.error) return j.result;
    } catch { /* fall through */ }
  }
  return withRpc(c => c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }));
}

async function confirm(sig) {
  return withRpc(async c => {
    const bh = await c.getLatestBlockhash("confirmed");
    const conf = await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  });
}

export async function swap({ keypair, inputMint, outputMint, amountRaw, slippageBps, dryRun }) {
  const qr = await quote(inputMint, outputMint, amountRaw, slippageBps);
  if (dryRun) return { signature: null, quote: qr, dryRun: true };
  const fee = await dynamicPriorityFee();
  const tx = await swapTx(qr, keypair.publicKey.toBase58(), fee);
  const sig = await broadcast(tx, keypair);
  await confirm(sig);
  return { signature: sig, quote: qr };
}

export const buySol = (keypair, mint, solAmount, slippageBps, dryRun) =>
  swap({ keypair, inputMint: SOL_MINT, outputMint: mint, amountRaw: Math.floor(solAmount * 1e9), slippageBps, dryRun });

export const sellAll = (keypair, mint, rawTokenAmount, slippageBps, dryRun) =>
  swap({ keypair, inputMint: mint, outputMint: SOL_MINT, amountRaw: rawTokenAmount, slippageBps, dryRun });
