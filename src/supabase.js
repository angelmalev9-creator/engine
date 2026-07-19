import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { config } from "./config.js";

export const sb = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

function must({ data, error }) {
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data;
}

// ── Per-user wallet encryption (AES-256-GCM, scrypt(pepper+userId, salt)) ──
export function encryptSecret(secretKeyBytes, userId) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(config.walletPepper + userId, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(secretKeyBytes)), cipher.final()]);
  return {
    alg: "aes-256-gcm", kdf: "scrypt",
    salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"),
  };
}

export function decryptSecret(c, userId) {
  const key = crypto.scryptSync(config.walletPepper + userId, Buffer.from(c.salt, "base64"), 32);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(c.iv, "base64"));
  d.setAuthTag(Buffer.from(c.tag, "base64"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(c.data, "base64")), d.final()]));
}

// ── Queries used by the engine ──────────────────────────────────────────────
export const q = {
  profile: async uid => must(await sb.from("profiles").select("*").eq("id", uid).single()),
  allProfiles: async () => must(await sb.from("profiles").select("*")),
  wallet: async uid => (await sb.from("user_wallets").select("*").eq("user_id", uid).maybeSingle()).data,
  insertWallet: async row => must(await sb.from("user_wallets").insert(row).select().single()),
  settings: async uid => (await sb.from("user_settings").select("overrides").eq("user_id", uid).maybeSingle()).data?.overrides || {},
  saveSettings: async (uid, overrides) =>
    must(await sb.from("user_settings").upsert({ user_id: uid, overrides, updated_at: new Date() }).select().single()),

  openPositions: async uid => must(await sb.from("positions").select("*")
    .in("status", ["open", "alert"]).order("opened_at", { ascending: false })
    .eq(uid ? "user_id" : "id", uid ?? undefined) ?? []),
  allActivePositions: async () => must(await sb.from("positions").select("*").in("status", ["open", "alert"])),
  userPositions: async (uid, limit = 50) => must(await sb.from("positions").select("*")
    .eq("user_id", uid).order("opened_at", { ascending: false }).limit(limit)),
  insertPosition: async row => must(await sb.from("positions").insert(row).select().single()),
  updatePosition: async (id, patch) => must(await sb.from("positions").update(patch).eq("id", id).select().single()),

  insertTx: async row => must(await sb.from("wallet_transactions").insert(row).select().single()),
  userTxs: async (uid, limit = 50) => must(await sb.from("wallet_transactions").select("*")
    .eq("user_id", uid).order("ts", { ascending: false }).limit(limit)),

  traders: async uid => must(await sb.from("tracked_traders").select("*").eq("user_id", uid).eq("active", true)),
  allActiveTraders: async () => must(await sb.from("tracked_traders").select("*").eq("active", true)),
  upsertTrader: async row => must(await sb.from("tracked_traders")
    .upsert(row, { onConflict: "user_id,address" }).select().single()),

  insertCopyEvent: async row => must(await sb.from("copy_events").insert(row).select().single()),
  userCopyEvents: async (uid, limit = 50) => must(await sb.from("copy_events").select("*")
    .eq("user_id", uid).order("ts", { ascending: false }).limit(limit)),

  insertSignal: async row => must(await sb.from("signals").insert(row).select().single()),
  recentSignals: async (limit = 40) => must(await sb.from("signals").select("*")
    .order("ts", { ascending: false }).limit(limit)),
};
