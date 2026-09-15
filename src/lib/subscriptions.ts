// Local subscriptions. A LocalTube subscription is private: it never touches a
// Google account and has no effect on YouTube's recommendations. It is only a
// list of channel ids this browser builds its feed from.

import { fetchChannelTitle } from '@/lib/feed';
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
export async function subscribe(channel: {
  id: string;
  title: string;
  avatar?: string;
}): Promise<void> {
  await updateData((data) => {
    const existing = data.subscriptions[channel.id];
    data.subscriptions[channel.id] = {
      id: channel.id,
      title: channel.title || existing?.title || channel.id,
      avatar: channel.avatar ?? existing?.avatar,
      addedAt: existing?.addedAt ?? Date.now(),
    };
  });
}

export async function unsubscribe(channelId: string): Promise<void> {
  await updateData((data) => {
    delete data.subscriptions[channelId];
  });
}

/** Returns the resulting state, so callers can update a button label. */
export async function toggleSubscription(channel: {
  id: string;
  title: string;
  avatar?: string;
}): Promise<boolean> {
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
