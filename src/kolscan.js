// kolscan.io has no official public API (acquired by pump.fun). Its
// leaderboard is server-rendered, so we parse trader wallets straight out of
// the live HTML: links of the form /account/<base58 pubkey> next to a name,
// win/loss record and daily PnL. Cached for 10 minutes; if the page layout
// changes, the scraper degrades gracefully to an empty list and copytrading
// falls back to each user's manually tracked wallets.
let cache = { ts: 0, traders: [] };
const TTL = 10 * 60_000;

export async function kolscanLeaderboard() {
  if (Date.now() - cache.ts < TTL && cache.traders.length) return cache.traders;
  try {
    const res = await fetch("https://kolscan.io/leaderboard", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; EmeraldGate/2.0)", accept: "text/html" },
    });
    if (!res.ok) throw new Error(`kolscan ${res.status}`);
    const html = await res.text();

    const traders = [];
    const seen = new Set();
    // <a href="/account/<pubkey>?timeframe=1"> ... alt="pfp <name>" ...
    const re = /href="\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})[^"]*"[^>]*>(?:[^<]*<img[^>]*alt="pfp ([^"]*)")?/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const address = m[1];
      if (seen.has(address)) continue;
      seen.add(address);
      traders.push({ address, name: (m[2] || address.slice(0, 6)).trim(), rank: traders.length + 1, source: "kolscan" });
    }
    // Fallback pattern if markup shifts: any /account/<pubkey> link.
    if (!traders.length) {
      const re2 = /\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})/g;
      while ((m = re2.exec(html)) !== null) {
        if (!seen.has(m[1])) { seen.add(m[1]); traders.push({ address: m[1], name: m[1].slice(0, 6), rank: traders.length + 1, source: "kolscan" }); }
      }
    }
    if (traders.length) cache = { ts: Date.now(), traders };
    return cache.traders;
  } catch {
    return cache.traders; // stale-if-error
  }
}
