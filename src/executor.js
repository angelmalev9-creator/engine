// Jupiter quote/swap execution.
// PAPER mode requests a real quote but never signs or broadcasts a transaction.
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { withRpc } from "./rpc.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// The current official Swap API is tried first. Older gateways remain fallbacks
// so PAPER testing does not stop during a migration or temporary gateway issue.
const JUPITER_BASES = [
  "https://api.jup.ag/swap/v1",
  "https://lite-api.jup.ag/swap/v1",
  "https://quote-api.jup.ag/v6",
];

export async function dynamicPriorityFee() {
  try {
    const fees = await withRpc(connection =>
      connection.getRecentPrioritizationFees()
    );

    const values = fees
      .map(fee => fee.prioritizationFee)
      .filter(value => value > 0)
      .sort((left, right) => left - right);

    if (!values.length) return 50_000;

    return Math.min(
      Math.max(values[Math.floor(values.length * 0.75)] * 2, 50_000),
      2_000_000
    );
  } catch {
    return 100_000;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      payload?.error ||
      payload?.message ||
      `${response.status} ${response.statusText}`;

    throw new Error(detail);
  }

  return payload;
}

async function quote(inputMint, outputMint, amount, slippageBps) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(Math.trunc(Number(amount))),
    slippageBps: String(Math.trunc(Number(slippageBps))),
    restrictIntermediateTokens: "true",
  });

  const errors = [];

  for (const apiBase of JUPITER_BASES) {
    try {
      const quoteResponse = await requestJson(
        `${apiBase}/quote?${params.toString()}`
      );

      if (!quoteResponse?.outAmount || Number(quoteResponse.outAmount) <= 0) {
        throw new Error("quote returned no output amount");
      }

      return { quoteResponse, apiBase };
    } catch (error) {
      errors.push(`${apiBase}: ${error.message}`);
    }
  }

  throw new Error(`Jupiter quote failed — ${errors.join(" | ")}`);
}

async function swapTx(quoteResponse, userPublicKey, fee, apiBase) {
  const payload = await requestJson(`${apiBase}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: fee,
    }),
  });

  if (!payload?.swapTransaction) {
    throw new Error("Jupiter swap returned no transaction");
  }

  return VersionedTransaction.deserialize(
    Buffer.from(payload.swapTransaction, "base64")
  );
}

async function broadcast(transaction, keypair) {
  transaction.sign([keypair]);

  if (config.jito.enabled) {
    try {
      const response = await fetch(
        `${config.jito.blockEngine}/api/v1/transactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sendTransaction",
            params: [bs58.encode(transaction.serialize())],
          }),
        }
      );

      const payload = await response.json();

      if (!payload.error) return payload.result;
    } catch {
      // Fall through to the configured Solana RPC.
    }
  }

  return withRpc(connection =>
    connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    })
  );
}

async function confirm(signature) {
  return withRpc(async connection => {
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const confirmation = await connection.confirmTransaction(
      { signature, ...blockhash },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(`Tx failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    return signature;
  });
}

export async function swap({
  keypair,
  inputMint,
  outputMint,
  amountRaw,
  slippageBps,
  dryRun,
}) {
  const { quoteResponse, apiBase } = await quote(
    inputMint,
    outputMint,
    amountRaw,
    slippageBps
  );

  if (dryRun) {
    return {
      signature: null,
      quote: quoteResponse,
      dryRun: true,
      quoteApi: apiBase,
    };
  }

  if (!keypair) {
    throw new Error("A keypair is required for LIVE execution");
  }

  const fee = await dynamicPriorityFee();
  const transaction = await swapTx(
    quoteResponse,
    keypair.publicKey.toBase58(),
    fee,
    apiBase
  );

  const signature = await broadcast(transaction, keypair);
  await confirm(signature);

  return { signature, quote: quoteResponse, quoteApi: apiBase };
}

export const buySol = (
  keypair,
  mint,
  solAmount,
  slippageBps,
  dryRun
) => swap({
  keypair,
  inputMint: SOL_MINT,
  outputMint: mint,
  amountRaw: Math.floor(Number(solAmount) * 1e9),
  slippageBps,
  dryRun,
});

export const sellAll = (
  keypair,
  mint,
  rawTokenAmount,
  slippageBps,
  dryRun
) => swap({
  keypair,
  inputMint: mint,
  outputMint: SOL_MINT,
  amountRaw: Math.trunc(Number(rawTokenAmount)),
  slippageBps,
  dryRun,
});
