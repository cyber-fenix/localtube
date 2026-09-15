// Local subscriptions. A LocalTube subscription is private: it never touches a
// Google account and has no effect on YouTube's recommendations. It is only a
// list of channel ids this browser builds its feed from.

import { fetchChannelTitle, pool } from '@/lib/feed';
import {
  channelViaInnertube,
  InnertubeRateLimited,
  innertubeAvailable,
} from '@/lib/innertube';
import { channelFromVideo } from '@/lib/oembed';
import type { FeedCache } from '@/types';
import { getData, updateData } from '@/lib/store';
import type { Subscription } from '@/types';

/** A subscription stored under its raw channel id because no name was known. */
export const isPlaceholderTitle = (s: Subscription): boolean => s.title === s.id;

export async function listSubscriptions(): Promise<Subscription[]> {
  const { subscriptions } = await getData();
  return Object.values(subscriptions).sort((a, b) => a.title.localeCompare(b.title));
}

export async function isSubscribed(channelId: string): Promise<boolean> {
  return Boolean((await getData()).subscriptions[channelId]);
}

/** Add a channel. Re-subscribing refreshes the title/avatar but keeps
 *  `addedAt`, so the list does not reshuffle. */
/** What a page can tell us about a channel. Everything past the id is optional
 *  because different pages expose different amounts. */
export interface ChannelDetails {
  id: string;
  title: string;
  avatar?: string;
  handle?: string;
  subscribers?: string;
}

export async function subscribe(channel: ChannelDetails): Promise<void> {
  await updateData((data) => {
    const existing = data.subscriptions[channel.id];
    data.subscriptions[channel.id] = {
      id: channel.id,
      title: channel.title || existing?.title || channel.id,
      avatar: channel.avatar ?? existing?.avatar,
      addedAt: existing?.addedAt ?? Date.now(),
      handle: channel.handle ?? existing?.handle,
      subscribers: channel.subscribers ?? existing?.subscribers,
      detailsAt: channel.handle || channel.subscribers ? Date.now() : existing?.detailsAt,
    };
  });
}

/**
 * Fill in what a page happens to know about a channel you already follow.
 *
 * The handle and subscriber count come only from YouTube's own page data, so a
 * channel followed before this existed — or imported from a Takeout file, which
 * carries neither — has neither until you next visit it. This is a no-op for
 * anyone not followed: LocalTube keeps no record of channels you did not ask
 * for.
 */
export async function noteChannelDetails(channel: ChannelDetails): Promise<void> {
  if (!channel.handle && !channel.subscribers && !channel.avatar) return;

  // Only write when something would actually change. Every storage write
  // re-runs the route (onDataChanged), and this is called on EVERY watch and
  // channel page visit — an unconditional write rebuilt the feed grid under
  // the user's cursor, visible as the feed "rapidly refreshing".
  const existing = (await getData()).subscriptions[channel.id];
  if (!existing) return; // keeps no record of channels you did not ask for
  const changed =
    (!existing.handle && channel.handle) ||
    (!existing.avatar && channel.avatar) ||
    (!existing.subscribers && channel.subscribers) ||
    (channel.handle != null && existing.handle !== channel.handle) ||
    (channel.avatar != null && existing.avatar !== channel.avatar) ||
    (channel.subscribers != null && existing.subscribers !== channel.subscribers);
  if (!changed) return;

  await updateData((data) => {
    const current = data.subscriptions[channel.id];
    if (!current) return;
    current.handle = channel.handle ?? current.handle;
    current.subscribers = channel.subscribers ?? current.subscribers;
    current.avatar = channel.avatar ?? current.avatar;
    if (channel.handle || channel.subscribers) current.detailsAt = Date.now();
  });
}

export async function unsubscribe(channelId: string): Promise<void> {
  await updateData((data) => {
    delete data.subscriptions[channelId];
  });
}

/** Returns the resulting state, so callers can update a button label. */
export async function toggleSubscription(channel: ChannelDetails): Promise<boolean> {
  if (await isSubscribed(channel.id)) {
    await unsubscribe(channel.id);
    return false;
  }
  await subscribe(channel);
  return true;
}

/**
 * Give a channel its real name if it was stored under its raw id.
 *
 * Returns the resolved name, or null if nothing changed. Safe to call for any
 * channel: it does nothing unless the stored title is still a placeholder.
 */
export async function resolveTitle(channelId: string): Promise<string | null> {
  const { subscriptions } = await getData();
  const existing = subscriptions[channelId];
  if (!existing || !isPlaceholderTitle(existing)) return null;

  const title = await fetchChannelTitle(channelId);
  if (!title || title === channelId) return null;

  await updateData((data) => {
    const subscription = data.subscriptions[channelId];
    // Re-check: the user may have unfollowed while the request was in flight.
    if (subscription && subscription.title === channelId) subscription.title = title;
  });
  return title;
}

/** Resolve every placeholder name at once. Returns how many were fixed. */
export async function resolveAllTitles(): Promise<number> {
  const { subscriptions } = await getData();
  const pending = Object.values(subscriptions).filter(isPlaceholderTitle).map((s) => s.id);
  if (pending.length === 0) return 0;

  let fixed = 0;
  // Small pool: this only ever covers the few channels followed through a
  // collaboration button, but it must not stampede if there are more.
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let id = pending.pop(); id; id = pending.pop()) {
      if (await resolveTitle(id)) fixed++;
    }
  });
  await Promise.all(workers);
  return fixed;
}

/** Bulk add, used by Takeout import and backup merge. Returns how many were new. */
export async function addMany(channels: { id: string; title: string }[]): Promise<number> {
  return updateData((data) => {
    let added = 0;
    for (const channel of channels) {
      if (!/^UC[\w-]{22}$/.test(channel.id)) continue; // skip malformed rows
      if (data.subscriptions[channel.id]) continue;
      data.subscriptions[channel.id] = {
        id: channel.id,
        title: channel.title || channel.id,
        addedAt: Date.now(),
      };
      added++;
    }
    return added;
  });
}


/**
 * Fill in the @handle of every followed channel that has none.
 *
 * Runs off the feed cache: identifying a channel through oEmbed means naming
 * one of its videos, and the cache already holds them. A channel with nothing
 * cached is skipped rather than fetched for — its feed will arrive on its own,
 * and this can pick it up next time.
 *
 * One small request per channel, at the same concurrency as the feed, and only
 * ever for channels that are missing a handle: once found, a handle is kept and
 * never asked for again. Reports how many were learned so the caller can patch
 * them into a page already on screen.
 */
export async function backfillHandles(
  cache: FeedCache,
  onFound?: (channelId: string, handle: string) => void,
): Promise<number> {
  const { subscriptions } = await getData();
  const missing = Object.values(subscriptions).filter(
    (channel) => !channel.handle && (cache[channel.id]?.videos.length ?? 0) > 0,
  );
  if (missing.length === 0) return 0;

  let found = 0;
  await pool(missing, async (channel) => {
    // Try a few of the channel's videos, not only its newest: oEmbed 404s on a
    // deleted or private video, and one of those at the top of a feed would
    // otherwise keep the whole channel from ever resolving.
    let result = null;
    for (const video of cache[channel.id].videos.slice(0, 3)) {
      result = await channelFromVideo(video.id);
      if (result?.handle) break;
    }
    if (!result?.handle) return;
    found++;
    await noteChannelDetails({
      id: channel.id,
      // Prefer the name we already show; oEmbed's is a fallback for a channel
      // still stored under its raw id.
      title: isPlaceholderTitle(channel) ? (result.title ?? channel.title) : channel.title,
      handle: result.handle,
    });
    onFound?.(channel.id, result.handle);
  });
  return found;
}

/**
 * Note channels the page's own cards taught us about, in one storage write.
 *
 * The MAIN-world bridge publishes the id, avatar and handle from every video
 * card YouTube renders; this is the filter that applies the standing rule —
 * it keeps a card's channel only if you already follow it, and only writes
 * when there is actually something new to keep. Both guards matter: cards
 * arrive in a steady trickle as you browse, and a write per trickle would
 * re-render every view per card.
 */
export async function noteHarvestedChannels(
  cards: { id: string; avatar?: string; handle?: string }[],
): Promise<void> {
  // One write for the whole batch, and none when nothing is new. Every
  // storage write re-runs the route (onDataChanged), and a feed re-render per
  // harvested card was measured as the feed "rapidly refreshing" for minutes
  // after a Takeout import.
  const { subscriptions } = await getData();
  const keep = cards.filter((card) => {
    const existing = subscriptions[card.id];
    if (!existing) return false; // the standing rule: only channels you follow
    return (card.avatar && !existing.avatar) || (card.handle && !existing.handle);
  });
  if (keep.length === 0) return;

  await updateData((data) => {
    for (const card of keep) {
      const subscription = data.subscriptions[card.id];
      if (!subscription) continue; // unfollowed while the read was in flight
      if (card.avatar && !subscription.avatar) subscription.avatar = card.avatar;
      if (card.handle && !subscription.handle) {
        subscription.handle = card.handle;
        subscription.detailsAt = Date.now();
      }
    }
  });
}

/** Channels already asked for this session, so a deleted one is not re-asked
 *  on every pass. */
const avatarAttempted = new Set<string>();

/** Circuit breaker: once Innertube answers 429, stop asking for a while —
 *  the initials just stay initials, which is infinitely better than feeding
 *  the rate limiter. */
let avatarBackoffUntil = 0;
const AVATAR_BACKOFF_MS = 15 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fill in the avatar of every followed channel that has none.
 *
 * Exists for Takeout imports: the CSV has id and title and nothing else, so
 * an imported list renders as bare initials. One Innertube browse call per
 * channel fills avatar, handle and subscriber count at once (see
 * lib/innertube.ts for why this endpoint), and only ever for channels missing
 * an avatar: once stored, an avatar is kept and never asked for again.
 * Reports each find so the caller can patch it into a page already on screen.
 *
 * Deliberately low-key: two workers with a short pause between calls. The
 * endpoint itself is cheap, but cadence is what rate limiters read — and a
 * previous version of this feature fetched full channel pages at pool
 * concurrency and got the answer 429 → a google.com/sorry redirect that
 * CORS-blocked the entire batch (observed live).
 */
export async function backfillAvatars(
  onFound?: (channelId: string, avatar: string) => void,
): Promise<number> {
  if (!innertubeAvailable() || Date.now() < avatarBackoffUntil) return 0;
  const { subscriptions } = await getData();
  const missing = Object.values(subscriptions).filter(
    (channel) => !channel.avatar && !avatarAttempted.has(channel.id),
  );
  if (missing.length === 0) return 0;

  let found = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < missing.length && Date.now() >= avatarBackoffUntil) {
      const channel = missing[cursor++];
      avatarAttempted.add(channel.id);
      const details = await channelViaInnertube(channel.id);
      if (details?.avatar) {
        found++;
        await noteChannelDetails({
          id: channel.id,
          title: channel.title,
          avatar: details.avatar,
          handle: details.handle,
          subscribers: details.subscribers,
        });
        onFound?.(channel.id, details.avatar);
      }
      if (cursor < missing.length) await sleep(200 + Math.random() * 300);
    }
  };
  try {
    await Promise.all([worker(), worker()]);
  } catch (error) {
    if (error instanceof InnertubeRateLimited) {
      avatarBackoffUntil = Date.now() + AVATAR_BACKOFF_MS;
      console.warn('[LocalTube] avatar backfill paused — Innertube rate-limited');
      return found;
    }
    throw error;
  }
  return found;
}
