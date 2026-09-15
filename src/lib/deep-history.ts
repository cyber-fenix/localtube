// Load a followed channel's older videos — everything past the Atom feed's 15.
//
// Explicitly user-initiated, per channel, and that is a design decision rather
// than an unfinished one. A page of 30 videos costs ~1.0-1.3 MB (measured
// live, 2026-09-11), so a channel with 500 uploads is ~19 MB and a background
// pass over a 300-channel Takeout import would be gigabytes. Nothing here runs
// on a schedule, on navigation, or on a feed refresh: it runs when someone
// presses the button, and it says what it is doing while it does it.
//
// The free alternative still applies and is preferred where it fits: visiting
// a channel page harvests whatever YouTube has already rendered there, at no
// request cost at all (content/harvest.ts).

import {
  InnertubeRateLimited,
  channelVideosViaInnertube,
  innertubeAvailable,
} from '@/lib/innertube';
import { mergeVideos } from '@/lib/feed';
import { parseAge, parseDuration, parseViews } from '@/lib/parse';
import { getData, getFeedCache, putFeedCache } from '@/lib/store';
import type { Video } from '@/types';

/** Pages per run, i.e. 30 videos each. A hard stop on both traffic and time:
 *  20 pages is ~600 videos and ~25 MB, which is already generous for one
 *  press of one button. */
const MAX_PAGES = 20;

/** Between pages. The same cadence every other Innertube caller here uses —
 *  cadence is what rate limiters read. */
const PAGE_PAUSE_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DeepHistoryResult {
  /** Videos this run added that the cache did not already have. */
  added: number;
  /** Everything the channel now has cached. */
  total: number;
  /** True when YouTube ran out of pages — the channel is fully loaded. */
  complete: boolean;
  /** Set when the run stopped early because YouTube rate-limited us. */
  rateLimited?: boolean;
}

/**
 * Page through a channel's uploads and merge them into its feed cache.
 *
 * Reports progress per page so the caller can keep a button honest about what
 * is happening. The storage write happens ONCE at the end, not per page: a
 * write per page would be a write storm of exactly the kind CLAUDE.md warns
 * about, with a feed rebuild behind each one.
 */
export async function loadChannelHistory(
  channelId: string,
  onProgress?: (loaded: number) => void,
): Promise<DeepHistoryResult> {
  const cache = await getFeedCache();
  const before = cache[channelId]?.videos ?? [];
  if (!innertubeAvailable()) return { added: 0, total: before.length, complete: false };

  const { subscriptions, settings } = await getData();
  const limit = settings.channelVideoLimit;
  const subscription = subscriptions[channelId];
  // The standing rule: LocalTube keeps no record of channels you did not ask
  // for, and this is a lot of record.
  if (!subscription) return { added: 0, total: before.length, complete: false };

  const collected: Video[] = [];
  let continuation: string | undefined;
  let complete = false;
  let rateLimited = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await channelVideosViaInnertube(channelId, continuation);
      if (!result || result.videos.length === 0) {
        complete = true;
        break;
      }

      for (const item of result.videos) {
        const published = parseAge(item.ageText);
        // No date, no place in a reverse-chronological feed — and guessing
        // "now" would shove an old upload above genuinely new ones.
        if (!published || !item.title) continue;
        collected.push({
          id: item.id,
          title: item.title,
          channelId,
          channelTitle: subscription.title,
          published,
          thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          views: parseViews(item.viewsText),
          duration: parseDuration(item.durationText),
          isShort: item.isShort,
        });
      }
      onProgress?.(collected.length);

      continuation = result.continuation;
      if (!continuation) {
        complete = true;
        break;
      }
      if (collected.length >= limit) break;
      await sleep(PAGE_PAUSE_MS);
    }
  } catch (error) {
    if (!(error instanceof InnertubeRateLimited)) throw error;
    rateLimited = true;
  }

  if (collected.length === 0)
    return { added: 0, total: before.length, complete, rateLimited };

  // Not authoritative: the Atom feed's exact publish dates and view counts win
  // over these, which are parsed from "3 months ago" and "756K views". What
  // this side uniquely brings is the videos the feed never carried at all.
  const merged = mergeVideos(before, collected, false, limit);
  const fresh = await getFeedCache();
  fresh[channelId] = {
    ...fresh[channelId],
    fetchedAt: fresh[channelId]?.fetchedAt ?? Date.now(),
    videos: merged,
    deep: true,
  };
  await putFeedCache(fresh, Object.keys(subscriptions));

  return { added: merged.length - before.length, total: merged.length, complete, rateLimited };
}
