// Turning YouTube's rendered text back into numbers and dates.
//
// Every one of these reads a string YouTube wrote for a human — a duration
// badge, a view count, an age like "4mo ago". They live here rather than in
// content/harvest.ts because the Innertube deep-history pass parses exactly
// the same strings out of JSON, and a lib module must not import from
// content/ to get them.
//
// All three are LANGUAGE-DEPENDENT and English-only by construction: a French
// page says "il y a 3 mois", which parseAge does not match. That is why
// callers reading these out of Innertube ask for `hl: 'en'` explicitly rather
// than taking the page's locale — see lib/innertube.ts.

/** "1:50" / "16:40" / "1:02:28" → seconds. */
export function parseDuration(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.trim().split(':').map((n) => Number(n));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : undefined;
}

/** "524K" / "1.2M views" / "7,712 views" → a number. */
export function parseViews(text?: string): number | undefined {
  if (!text) return undefined;
  const match = /([\d.,]+)\s*([KMB])?/i.exec(text.replace(/\s/g, ''));
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return undefined;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(value * scale);
}

/**
 * "4mo ago" / "3 days ago" / "1y ago" → an ISO date.
 *
 * An approximation, and knowingly so: the channel page states ages, not dates.
 * It is resolved to an absolute timestamp here, at harvest time, so it does not
 * drift afterwards, and the Atom feed's exact date always wins where both exist
 * (see mergeVideos). Its only job is to sort a video roughly correctly among
 * others in the feed.
 */
export function parseAge(text?: string): string | undefined {
  if (!text) return undefined;
  const match = /(\d+)\s*(mo|[smhdwy])[a-z]*\s*ago/i.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
    y: 31_536_000_000,
  };
  const span = ms[unit];
  if (!span || !Number.isFinite(amount)) return undefined;
  return new Date(Date.now() - amount * span).toISOString();
}
