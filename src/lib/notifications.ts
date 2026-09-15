// The bell: new uploads from channels you follow, waiting to be looked at.
//
// LocalTube has no background worker and asks for no `notifications`
// permission, so this is not a desktop alert — it is YouTube's own bell,
// filled from LocalTube's own feed. New videos are noticed by the refresh that
// was already running (lib/feed.ts), which means the bell fills while you are
// on YouTube and never while you are not. That is the whole trade, and the
// popup says so rather than implying a background service.

import { NOTIFICATION_LIMIT, getData, updateData } from '@/lib/store';
import type { NotificationEntry, Video } from '@/types';

/**
 * How old an upload can be and still raise a notification.
 *
 * A channel that has been quiet for a year, or one whose feed LocalTube reads
 * for the first time, would otherwise announce videos nobody would call new.
 * The refresh already suppresses a channel's first load entirely; this covers
 * the rest — a re-followed channel, a feed that returns something ancient.
 */
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export async function listNotifications(): Promise<NotificationEntry[]> {
  return (await getData()).notifications;
}

export async function unreadCount(): Promise<number> {
  return (await getData()).notifications.filter((entry) => !entry.read).length;
}

/**
 * Record uploads the feed refresh just discovered.
 *
 * One write for the batch, and none at all when nothing qualifies — the same
 * rule every writer here follows, because a storage write re-runs the route in
 * every tab.
 */
export async function noteNewUploads(videos: Video[]): Promise<number> {
  if (videos.length === 0) return 0;
  const data = await getData();
  if (!data.settings.notifyUploads) return 0;

  const known = new Set(data.notifications.map((entry) => entry.videoId));
  const now = Date.now();
  const fresh = videos.filter((video) => {
    if (known.has(video.id)) return false;
    if (!data.subscriptions[video.channelId]) return false;
    const published = Date.parse(video.published);
    return Number.isFinite(published) && now - published < MAX_AGE_MS;
  });
  if (fresh.length === 0) return 0;

  await updateData((current) => {
    // Re-check inside the write: the same pass in another tab may have got
    // here first, and a duplicate row in the bell is a visible bug.
    const already = new Set(current.notifications.map((entry) => entry.videoId));
    const entries: NotificationEntry[] = [];
    for (const video of fresh) {
      if (already.has(video.id)) continue;
      already.add(video.id);
      entries.push({
        videoId: video.id,
        title: video.title,
        channelId: video.channelId,
        channelTitle: video.channelTitle,
        thumbnail: video.thumbnail,
        published: video.published,
        seenAt: now,
      });
    }
    if (entries.length === 0) return;
    current.notifications = [...entries, ...current.notifications]
      .sort((a, b) => b.seenAt - a.seenAt || Date.parse(b.published) - Date.parse(a.published))
      .slice(0, NOTIFICATION_LIMIT);
  });
  return fresh.length;
}

/** Clear the badge. The rows stay: the panel is a list, not an inbox. */
export async function markAllRead(): Promise<void> {
  const data = await getData();
  if (data.notifications.every((entry) => entry.read)) return;
  await updateData((current) => {
    for (const entry of current.notifications) entry.read = true;
  });
}

export async function clearNotifications(): Promise<void> {
  const data = await getData();
  if (data.notifications.length === 0) return;
  await updateData((current) => {
    current.notifications = [];
  });
}
