import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { withRpc } from "./rpc.js";
import { decryptSecret, encryptSecret, q } from "./supabase.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const kpCache = new Map(); // userId -> Keypair (in-memory only)

// Every account gets a real, unique Solana keypair, encrypted per-user in Supabase.
export async function ensureUserWallet(userId) {
  let row = await q.wallet(userId);
  if (!row) {
    const kp = Keypair.generate();
    row = await q.insertWallet({
      user_id: userId,
      public_key: kp.publicKey.toBase58(),
      secret_ciphertext: encryptSecret(kp.secretKey, userId),
    });
    kpCache.set(userId, kp);
  }
  return row.public_key;
}

export async function userKeypair(userId) {
  if (kpCache.has(userId)) return kpCache.get(userId);
  const row = await q.wallet(userId);
  if (!row) throw new Error("Wallet not found");
  const kp = Keypair.fromSecretKey(decryptSecret(row.secret_ciphertext, userId));
  kpCache.set(userId, kp);
  return kp;
}

export async function balanceSol(publicKey) {
  const lamports = await withRpc(c => c.getBalance(new PublicKey(publicKey), "confirmed"));
  return lamports / LAMPORTS_PER_SOL;
}

export async function tokenBalances(publicKey) {
  const res = await withRpc(c =>
    c.getParsedTokenAccountsByOwner(new PublicKey(publicKey), { programId: TOKEN_PROGRAM }));
  return res.value.map(({ account }) => {
    const i = account.data.parsed.info;
    return { mint: i.mint, amount: Number(i.tokenAmount.uiAmount || 0), decimals: i.tokenAmount.decimals };
  }).filter(t => t.amount > 0);
}
