// Copy an existing YouTube playlist into a local LocalTube one.
//
// What arrives is an ORDINARY local playlist — no special type, no separate
// view, no sync loop. That is the whole design: queue, shuffle, the playlist
// page, backup and restore all work on it the moment it exists, because it is
// the same thing "New playlist" makes.
//
// It reads YouTube's own playlist browse (lib/innertube.ts) with no new
// permission. The competitor that ships this feature asks for
// `declarativeNetRequestWithHostAccess` so it can referrer-spoof an embed;
// LocalTube's permission list is its strongest claim on the store page, so the
// feature was only worth building on a path that leaves it alone.
//
// Explicitly user-initiated, like lib/deep-history.ts and for the same reason:
// a 100-video page costs ~4.7 MB (measured live, 2026-09-11). Nothing here runs
// on a schedule, on navigation, or on a feed refresh — it runs when someone
// presses the button, and the button says what it is doing while it does.

import { InnertubeRateLimited, innertubeAvailable, playlistViaInnertube } from '@/lib/innertube';
import { parseAge, parseDuration, parseViews } from '@/lib/parse';
import { getData, updateData } from '@/lib/store';
import { t } from '@/lib/i18n';
import type { Playlist, Video } from '@/types';

/**
 * Pages per run, i.e. 100 videos each.
 *
 * A hard stop on traffic: five pages is ~24 MB, the same budget the deep
 * history load gets for one press of one button. A longer playlist is imported
 * up to this point and says so, rather than quietly downloading for a minute.
 */
const MAX_PAGES = 5;

/** Between pages. The cadence every Innertube caller here uses — cadence is
 *  what rate limiters read. */
const PAGE_PAUSE_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ImportResult {
  playlist: Playlist;
  /** Videos this run added that the playlist did not already have. */
  added: number;
  /** Everything the playlist now holds. */
  total: number;
  /** True when YouTube ran out of pages — the whole playlist was read. */
  complete: boolean;
  /** Set when the run stopped early because YouTube rate-limited us. */
  rateLimited?: boolean;
}

export class PlaylistUnavailable extends Error {}

/** The local playlist already copied from this YouTube playlist, if any. */
export async function savedFromYouTube(playlistId: string): Promise<Playlist | undefined> {
  const { playlists } = await getData();
  return Object.values(playlists).find((p) => p.sourcePlaylistId === playlistId);
}

/**
 * Read a YouTube playlist and save (or refresh) it as a local playlist.
 *
 * Pressing the button again on a playlist already saved refreshes it: videos
 * YouTube has since added appear, and anything the user removed locally stays
 * removed unless YouTube still lists it. YouTube's order wins for everything
 * it lists, with locally-added extras kept on the end — a playlist is an
 * ordered list, and reversing it on every refresh would be its own bug.
 *
 * `onProgress` is called per page so the caller can keep its button honest.
 */
export async function savePlaylistFromYouTube(
  playlistId: string,
  onProgress?: (loaded: number) => void,
): Promise<ImportResult> {
  if (!innertubeAvailable()) throw new PlaylistUnavailable(t('error_cannot_read_page_yet'));

  const collected: Video[] = [];
  const seen = new Set<string>();
  let title: string | undefined;
  let continuation: string | undefined;
  let complete = false;
  let rateLimited = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await playlistViaInnertube(playlistId, continuation);
      // The first page failing means the playlist does not resolve at all —
      // deleted, private, or a malformed id. A LATER page failing is a
      // genuine error mid-walk, so it keeps what we have and says so.
      if (!result) {
        if (page === 0) throw new PlaylistUnavailable(t('error_playlist_could_not_be_read'));
        break;
      }
      // A page with no videos is the end. Every playlist shorter than one
      // page still offers a continuation token, and it answers with nothing —
      // so this, not the absence of a token, is what usually ends the walk.
      if (result.videos.length === 0) {
        complete = true;
        break;
      }
      title ??= result.title;

      for (const item of result.videos) {
        if (!item.title || seen.has(item.id)) continue;
        seen.add(item.id);
        collected.push({
          id: item.id,
          title: item.title,
          channelId: item.channelId ?? '',
          channelTitle: item.channelTitle ?? '',
          // A playlist is an ORDERED list, so unlike a feed import a video
          // with no stated age is kept rather than dropped: its place here is
          // its position, not its date. An empty string renders as no date at
          // all (see timeAgo), which is the honest thing to show.
          published: parseAge(item.ageText) ?? '',
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
      await sleep(PAGE_PAUSE_MS);
    }
  } catch (error) {
    if (error instanceof PlaylistUnavailable) throw error;
    if (!(error instanceof InnertubeRateLimited)) throw error;
    rateLimited = true;
    if (collected.length === 0) throw new PlaylistUnavailable(t('error_youtube_rate_limiting'));
  }

  if (collected.length === 0) throw new PlaylistUnavailable(t('error_playlist_nothing_to_save'));

  const now = Date.now();
  const result = await updateData((data) => {
    const existing = Object.values(data.playlists).find((p) => p.sourcePlaylistId === playlistId);
    const before = existing?.videos ?? [];
    const byId = new Map(before.map((video) => [video.id, video]));

    // YouTube's order for everything it lists; anything the user added here
    // themselves keeps its place on the end.
    const merged: Video[] = collected.map((video) => {
      const kept = byId.get(video.id);
      byId.delete(video.id);
      // An existing entry keeps its addedAt — when YOU saved it is local
      // history and not YouTube's to overwrite — and takes the fresher
      // metadata otherwise.
      return { ...video, addedAt: kept?.addedAt ?? now, duration: video.duration ?? kept?.duration };
    });
    for (const leftover of before) if (byId.has(leftover.id)) merged.push(leftover);

    const playlist: Playlist = existing
      ? { ...existing, name: existing.name, videos: merged, sourceSyncedAt: now }
      : {
          id: `pl-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          // The YouTube playlist's own name, falling back to something a user
          // can find rather than to the raw id.
          name: title?.trim() || 'Saved from YouTube',
          videos: merged,
          createdAt: now,
          sourcePlaylistId: playlistId,
          sourceSyncedAt: now,
        };
    data.playlists[playlist.id] = playlist;
    return { playlist, added: merged.length - before.length, total: merged.length };
  });

  return { ...result, complete, rateLimited };
}
