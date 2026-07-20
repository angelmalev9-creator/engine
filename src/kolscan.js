// Kolscan leaderboard scraper.
//
// Kolscan does not expose a documented public JSON API. This parser reads the
// public leaderboard HTML and extracts the wallet, name, W/L and displayed PnL.
// It is deliberately stale-if-error because layout changes must never stop the
// copytrade engine.
let cache = {
  ts: 0,
  traders: [],
};

const TTL = 2 * 60_000;
const ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function textOnly(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function number(value) {
  const parsed = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSegment(segment, address, rank) {
  const nameMatch = segment.match(/alt="pfp\s+([^"]*)"/i);
  const text = textOnly(segment);

  const pnlSolMatch = text.match(/([+-]?\d[\d,]*(?:\.\d+)?)\s*Sol\b/i);
  const pnlUsdMatch = text.match(/\(\s*\$([+-]?[\d,]+(?:\.\d+)?)\s*\)/i);
  const winLossMatch = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);

  const wins = winLossMatch ? number(winLossMatch[1]) : null;
  const losses = winLossMatch ? number(winLossMatch[2]) : null;
  const total = (wins ?? 0) + (losses ?? 0);

  return {
    address,
    name: decodeHtml(nameMatch?.[1] || address.slice(0, 6)).trim(),
    rank,
    wins,
    losses,
    winRate: total > 0 ? (wins / total) * 100 : null,
    pnlSol: number(pnlSolMatch?.[1]),
    pnlUsd: number(pnlUsdMatch?.[1]),
    timeframe: "daily",
    source: "kolscan",
  };
}

function parseLeaderboard(html) {
  const linkRe = new RegExp(
    `href="/account/(${ADDRESS_RE.source})[^"]*"`,
    "g"
  );

  const matches = [];
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    matches.push({
      index: match.index,
      address: match[1],
    });
  }

  const traders = [];
  const seen = new Set();

  for (let index = 0; index < matches.length; index++) {
    const current = matches[index];
    if (seen.has(current.address)) continue;

    const nextIndex = matches[index + 1]?.index ?? html.length;
    const segment = html.slice(current.index, nextIndex);
    const trader = parseSegment(
      segment,
      current.address,
      traders.length + 1
    );

    seen.add(current.address);
    traders.push(trader);
  }

  return traders;
}

export async function kolscanLeaderboard() {
  if (
    Date.now() - cache.ts < TTL &&
    cache.traders.length
  ) {
    return cache.traders;
  }

  try {
    const response = await fetch("https://kolscan.io/leaderboard", {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; EmeraldGate/3.0)",
        accept: "text/html",
      },
    });

    if (!response.ok) {
      throw new Error(`kolscan ${response.status}`);
    }

    const html = await response.text();
    const traders = parseLeaderboard(html);

    if (traders.length) {
      cache = {
        ts: Date.now(),
        traders,
      };
    }

    return cache.traders;
  } catch (error) {
    console.error(`kolscan: ${error.message}`);
    return cache.traders;
  }
}
