import "dotenv/config";

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? Number(process.env[k]) : d);
const bool = (k, d) => (process.env[k] !== undefined ? process.env[k] === "true" : d);

export const config = {
  port: num("PORT", 3000),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  walletPepper: process.env.WALLET_PEPPER || "",
  rpcEndpoints: (process.env.RPC_ENDPOINTS || "https://api.mainnet-beta.solana.com")
    .split(",").map(s => s.trim()).filter(Boolean),
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  liveTrading: bool("LIVE_TRADING", false), // global kill switch on top of per-user plan
  jito: {
    enabled: bool("JITO_ENABLED", false),
    blockEngine: process.env.JITO_BLOCK_ENGINE || "https://mainnet.block-engine.jito.wtf",
  },
  // Global security gate (applied to every token for every user).
  security: {
    maxRugcheckScore: num("MAX_RUGCHECK_SCORE", 20),
    minLpLockedPct: num("MIN_LP_LOCKED_PCT", 95),
    maxTop10HolderPct: num("MAX_TOP10_HOLDER_PCT", 15),
  },
};

// "Best settings" defaults. Each user can override any of these from the
// dashboard; missing keys always fall back to these values.
export const DEFAULT_SETTINGS = {
  // PAPER is the safe default. LIVE must be selected explicitly by the user
  // and is still protected by the Railway LIVE_TRADING kill switch.
  tradingMode: "paper",
  paperStartingSol: 10,

  // Automatically executes PAPER entries from the dense V3 market scanner.
  // This never signs or broadcasts a Solana transaction.
  paperAutoTradeEnabled: true,
  paperAutoEntriesPerTick: 1,
  paperReentryCooldownMin: 30,

  // active = enough PAPER trades to test the strategy:
  // relaxed discovery thresholds, but obvious scam checks stay blocking.
  // strict = every dashboard entry rule + every security check must pass.
  paperStrategyProfile: "active",

  sniperEnabled: true,
  copytradeEnabled: true,
  buySizeSol: 0.1,          // sniper position size
  copySizeSol: 0.05,        // per copied trade
  maxOpenPositions: 3,
  slippageBps: 300,
  followKolscanTop: 5,      // auto-follow top N from kolscan leaderboard (0 = off)
  entry: {
    minLiquiditySol: 15,
    minTxns5m: 80,
    minBuySellRatio: 2.0,
    requireDexPaid: true,
    requireSocials: true,
    maxPairAgeMin: 60,
  },
  exit: {
    baseTpPct: 30,
    trailArmPct: 30,
    trailDropPct: 10,
    hardSlPct: -15,
    maxHoldMinutes: 35,
    volumeDryupPct: 85,
  },
};

export function mergeSettings(overrides = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    entry: { ...DEFAULT_SETTINGS.entry, ...(overrides.entry || {}) },
    exit: { ...DEFAULT_SETTINGS.exit, ...(overrides.exit || {}) },
  };
}

export function assertConfig() {
  if (!config.walletPepper || config.walletPepper.length < 32)
    throw new Error("WALLET_PEPPER must be ≥32 random characters.");
  if (!config.supabaseUrl || !config.supabaseServiceKey || !config.supabaseAnonKey)
    throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.");
}
