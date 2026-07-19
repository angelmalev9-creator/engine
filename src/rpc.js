// Rotating RPC pool. Round-robins endpoints, benches an endpoint for 60s
// after a 403/429/timeout, and retries the call on the next endpoint.
import { Connection } from "@solana/web3.js";
import { config } from "./config.js";

const BENCH_MS = 60_000;

const pool = config.rpcEndpoints.map(url => ({
  url,
  conn: new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true }),
  benchedUntil: 0,
  failures: 0,
}));

let cursor = 0;

function nextHealthy() {
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const ep = pool[(cursor + i) % pool.length];
    if (ep.benchedUntil <= now) {
      cursor = (cursor + i + 1) % pool.length;
      return ep;
    }
  }
  // All benched — take the least recently benched anyway.
  return pool.reduce((a, b) => (a.benchedUntil < b.benchedUntil ? a : b));
}

export async function withRpc(fn, { attempts = pool.length + 1 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ep = nextHealthy();
    try {
      return await fn(ep.conn, ep.url);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (/403|429|timed? ?out|fetch failed|ECONN|ETIMEDOUT|Too Many/i.test(msg)) {
        ep.failures++;
        ep.benchedUntil = Date.now() + BENCH_MS;
      }
    }
  }
  throw lastErr;
}

export function rpcStatus() {
  const now = Date.now();
  return pool.map(ep => ({
    url: ep.url.replace(/api-key=[^&]+/i, "api-key=***"),
    healthy: ep.benchedUntil <= now,
    failures: ep.failures,
  }));
}
