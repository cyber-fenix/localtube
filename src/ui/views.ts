// The LocalTube views. They render into a container the content script
// mounts inside YouTube's home page; nothing here knows about YouTube's DOM.

import { writesAllowed } from '@/content/account';
import { flashToast, showToast } from '@/content/toast';
import { loadFeed, mergeCache, type FeedStatus } from '@/lib/feed';
import { backfillVideoDetails } from '@/lib/video-details';
import { loadChannelHistory } from '@/lib/deep-history';
import { PlaylistUnavailable, savePlaylistFromYouTube } from '@/lib/import-playlist';
import { innertubeAvailable } from '@/lib/innertube';
import { deletePlaylist, getPlaylist, listPlaylists, removeFromPlaylist, renamePlaylist, createPlaylist } from '@/lib/playlists';
import { listProgress, watchedFraction } from '@/lib/progress';
import { clearHistory, historyEnabled, listHistory, removeFromHistory, setHistoryEnabled } from '@/lib/history';
import { HISTORY_LIMIT, getData, getFeedCache } from '@/lib/store';
import {
  backfillAvatars,
  backfillHandles,
  isPlaceholderTitle,
  listSubscriptions,
  resolveAllTitles,
  unsubscribe,
} from '@/lib/subscriptions';
import {
  durationBadge,
  progressBar,
  progressFor,
  watchHref, emptyState, formatViews, kebab, shortsShelf, timeAgo, videoGrid } from '@/ui/cards';
import { PATHS, icon } from '@/ui/icons';
import { clearShuffle, shuffled, writeShuffle } from '@/lib/shuffle';
import { t } from '@/lib/i18n';
import type { HistoryEntry, Playlist, ProgressEntry, Video } from '@/types';

export type View =
  | { name: 'feed' }
  | { name: 'subscriptions' }
  | { name: 'playlists' }
  | { name: 'playlist'; id: string }
  // Watch Later and Liked are ordinary playlists with fixed ids, but they get
  // their own view names so the sidebar can link to them without knowing the
  // id — a restored backup could carry different ones.
  | { name: 'watch-later' }
  | { name: 'liked' }
  | { name: 'history' };

const PAGE_SIZE = 60;

/** How many Shorts the shelf holds. It is one horizontal row, so this is a
 *  scroll length, not a page — the videos below it are the point of the page. */
const SHORTS_SHELF = 24;

export const viewHash = (view: View): string =>
  view.name === 'playlist' ? `#localtube=playlist:${view.id}` : `#localtube=${view.name}`;

/** Parse `#localtube=...`. Returns null when the hash names no LocalTube view. */
export function parseViewHash(hash: string): View | null {
  const match = /#localtube=([^&]+)/.exec(hash);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  if (
    value === 'subscriptions' ||
    value === 'playlists' ||
    value === 'feed' ||
    value === 'watch-later' ||
    value === 'liked' ||
    value === 'history'
  )
    return { name: value };
  if (value.startsWith('playlist:')) return { name: 'playlist', id: value.slice('playlist:'.length) };
  return null;
}

/**
 * Switch view without touching location.hash.
 *
 * Assigning to location.hash fires a real `hashchange` on the window — an event
 * YouTube's own router may act on, and which drove a full route() re-run
 * (re-mounting the nav rail, subscribe button and queue) for what is only an
 * internal view change. pushState updates the URL, so back/forward and copied
 * links still work, but nothing outside LocalTube hears about it.
 */
export function go(view: View): void {
  history.pushState(null, '', viewHash(view));
  window.dispatchEvent(new CustomEvent(VIEW_CHANGED));
}

/** Fired when LocalTube changes its own view; src/content/home.ts listens. */
export const VIEW_CHANGED = 'localtube:view';

/**
 * A filter box for a view's own controls row.
 *
 * It filters the list ALREADY on screen, on every keystroke, and never touches
 * storage — the same rule History's search follows, and for the same reason: a
 * round-trip per character would be visible, and what is loaded is what the
 * user is looking at. Nothing here is remembered between renders either; a
 * filter is a thing you are doing, not a setting.
 */
function searchField(placeholder: string, onQuery: (query: string) => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'lt-search';
  box.appendChild(icon(PATHS.search));
  const field = document.createElement('input');
  field.type = 'search';
  field.placeholder = placeholder;
  field.setAttribute('aria-label', placeholder);
  field.addEventListener('input', () => onQuery(field.value));
  box.appendChild(field);
  return box;
}

/** Lower-cased needle, or '' when the query is only whitespace. */
const needleOf = (query: string): string => query.trim().toLowerCase();

/** Does this video match? Title and channel, which is what someone types. */
const videoMatches = (video: Video, needle: string): boolean =>
  !needle || `${video.title} ${video.channelTitle}`.toLowerCase().includes(needle);

function localOnlyNote(): HTMLElement {
  const note = document.createElement('p');
  note.className = 'lt-note';
  note.textContent = t('local_only_note');
  return note;
}

/* ----------------------------------------------------------------- feed */

export async function feedView(root: HTMLElement, token: () => boolean): Promise<void> {
  // The avatar YouTube shows beside each title. We have one only for channels
  // you follow — which, on a feed built from your follows, is all of them.
  const [{ subscriptions, settings }, progress] = await Promise.all([getData(), listProgress()]);
  const avatarFor = (video: Video): string | undefined => subscriptions[video.channelId]?.avatar;
  const watched = progressFor(progress);
  const hideShorts = settings.hideShorts;

  const status = document.createElement('span');
  status.className = 'lt-status';

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'lt-btn';
  refresh.textContent = t('action_refresh');

  // Filters the videos already loaded — including the ones past the current
  // page, so a match further down the feed is findable without pressing Load
  // more first.
  let query = '';
  // Assigned once paint() exists, a few lines below; the field cannot be typed
  // into before then.
  let paintLatest = (): void => undefined;
  const search = searchField(t('filter_feed_placeholder'), (value) => {
    query = value;
    paintLatest();
  });

  // Built detached and attached in a single swap on the first paint. Attaching
  // an empty body first and filling it after the await left the page visibly
  // blank for three storage round-trips on every switch to this tab.
  const body = document.createElement('div');
  const bar = document.createElement('div');
  bar.className = 'lt-actions';
  bar.append(search, status, refresh);
  const note = localOnlyNote();
  let attached = false;
  const attach = (): void => {
    // The token matters here exactly as much as in paint: a write landing a
    // few seconds into the first paint re-runs the route, which starts a
    // SECOND feedView against the same root. paint() refuses to paint stale,
    // but if this stale instance's attach then ran, it would replaceChildren
    // its never-painted EMPTY body over the live grid — the feed "vanished
    // seconds after first paint" until a full refresh.
    if (attached || !token()) return;
    attached = true;
    root.replaceChildren(bar, body, note);
  };

  let shown = PAGE_SIZE;
  let latest: Video[] = [];
  let latestStatus: FeedStatus = { refreshing: 0, done: 0, failed: [] };

  const paint = (videos: Video[], feedStatus: FeedStatus): void => {
    if (!token()) return;
    latest = videos;
    latestStatus = feedStatus;
    if (feedStatus.done < feedStatus.refreshing) {
      status.textContent = t('feed_status_updating', [String(feedStatus.done), String(feedStatus.refreshing)]);
    } else if (feedStatus.failed.length > 0) {
      // "5 channels could not be loaded" is a dead end on its own: the reason
      // and the channel are both known, and both are already shown per row on
      // the subscriptions page. Say which, and how to get there.
      const count = feedStatus.failed.length;
      status.textContent = t('feed_status_failed_count', String(count));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'lt-status-link';
      link.textContent = t('feed_status_see_which');
      link.title = t('feed_status_see_which_title');
      link.addEventListener('click', () => go({ name: 'subscriptions' }));
      status.appendChild(link);
    } else {
      status.textContent = '';
    }

    const needle = needleOf(query);
    const matching = needle ? videos.filter((video) => videoMatches(video, needle)) : videos;

    // Anything not yet classified is treated as an ordinary video, so a
    // classification that has not arrived can never make a video vanish.
    const shorts = hideShorts ? [] : matching.filter((video) => video.isShort === true);
    const rest = matching.filter((video) => video.isShort !== true);

    if (rest.length === 0 && shorts.length === 0) {
      body.replaceChildren(
        needle
          ? emptyState(t('empty_no_matches_title'), t('empty_feed_no_matches_body', query.trim()))
          : videos.length > 0 && hideShorts
          ? emptyState(t('empty_only_shorts_title'), t('empty_only_shorts_body'))
          : emptyState(t('empty_feed_title'), t('empty_feed_body'), {
              label: t('action_view_subscriptions'),
              onClick: () => go({ name: 'subscriptions' }),
            }),
      );
      attach();
      return;
    }

    // The shelf is rebuilt from scratch below like everything else in `body`,
    // which resets its scrollLeft to 0 — including on a background repaint
    // (durations/Shorts classification arriving, another channel's feed
    // landing) that has nothing to do with what's on screen. Scrolling the
    // shelf right as one of those lands is what "snaps back to the first
    // Short" for no visible reason. Carried across the rebuild instead of
    // fixed by not rebuilding: the shelf's own contents can legitimately
    // change underneath it (a Short just reclassified, one just dropped for
    // having no real thumbnail), so keeping the same nodes isn't safe — only
    // where the user had scrolled to is worth preserving.
    const shortsScroll = body.querySelector('.lt-shorts-row')?.scrollLeft ?? 0;

    const parts: HTMLElement[] = [];
    if (shorts.length > 0) parts.push(shortsShelf(shorts.slice(0, SHORTS_SHELF)));
    if (rest.length > 0)
      parts.push(
        videoGrid(rest.slice(0, shown), undefined, {
          avatar: avatarFor,
          progress: watched,
        }),
      );
    body.replaceChildren(...parts);
    if (shortsScroll > 0) {
      const newRow = body.querySelector<HTMLElement>('.lt-shorts-row');
      if (newRow) newRow.scrollLeft = shortsScroll;
    }
    if (rest.length > shown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'lt-btn';
      more.style.margin = '24px auto';
      more.style.display = 'block';
      more.textContent = t('action_load_more');
      more.addEventListener('click', () => {
        shown += PAGE_SIZE;
        paint(latest, feedStatus);
      });
      body.appendChild(more);
    }
    attach();
  };

  // Re-paint what is already loaded, e.g. when the filter changes. Declared
  // after paint so it always uses the current one.
  paintLatest = (): void => paint(latest, latestStatus);

  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void loadFeed(paint, { force: true }).finally(() => {
      refresh.disabled = false;
    });
  });

  await loadFeed(paint);
  // loadFeed always paints at least once, but never leave the view unattached.
  attach();

  // Then fill in what the feed itself cannot say: lengths, and which of these
  // are Shorts. This writes the feed cache — NOT the data key — so it cannot
  // re-run the route; the repaint has to come from here, throttled the way
  // loadFeed throttles its own.
  if (!token()) return;
  const cache = await getFeedCache();
  const channelIds = Object.keys(subscriptions);
  let lastPaint = 0;
  const repaint = (): void => {
    if (!token() || Date.now() - lastPaint < 600) return;
    lastPaint = Date.now();
    // Same status as the last paint: a details pass says nothing about
            // whether a channel's feed loaded, and must not clear that notice.
            paint(mergeCache(cache, channelIds), latestStatus);
  };
  const found = await backfillVideoDetails(cache, channelIds, repaint);
  if (found > 0 && token()) {
    lastPaint = 0;
    repaint();
  }
}

/* -------------------------------------------------------- subscriptions */

/** How the channel list is ordered. YouTube's chip says "Most relevant"; ours
 *  says what it actually does, because there is no relevance model here. */
type ChannelSort = 'recent' | 'name';
let channelSort: ChannelSort = 'recent';
const sortLabel = (sort: ChannelSort): string =>
  sort === 'name' ? t('sort_name_az') : t('sort_recently_followed');

/** YouTube's chevron, as it appears at the end of a chip. */
const CHIP_CHEVRON = 'M18.707 8.793a1 1 0 00-1.414 0L12 14.086 6.707 8.793a1 1 0 10-1.414 1.414L12 16.914l6.707-6.707a1 1 0 000-1.414Z';

/** "N videos" / "N recent videos", used both for the metadata line and the
 *  description-line fallback below it. */
const videoCountLabel = (count: number, deep: boolean): string =>
  deep ? t('videos_count_all', String(count)) : t('videos_count_recent', String(count));

export async function subscriptionsView(root: HTMLElement, rerender: () => void): Promise<void> {
  const [subscriptions, cache] = await Promise.all([listSubscriptions(), getFeedCache()]);
  const writable = writesAllowed();

  const ordered = subscriptions.slice().sort((a, b) => {
    if (channelSort === 'name') return a.title.localeCompare(b.title);
    return b.addedAt - a.addedAt;
  });

  const body = document.createElement('div');
  body.className = 'lt-channels';

  /** Every row, kept so the filter can hide rather than rebuild. */
  const rows: { channel: (typeof ordered)[number]; row: HTMLElement }[] = [];

  if (subscriptions.length === 0) {
    body.appendChild(emptyState(t('empty_no_channels_title'), t('empty_no_channels_body')));
  }

  // Laid out like YouTube's own /feed/channels, measured on a live page: a
  // 136px avatar with 16px to the text, a 400 18px/26px name with 8px beneath
  // it, a 12px/18px metadata line with 4px beneath it, a two-line description,
  // and the follow control in a block on the right. Rows are 136 tall with
  // 16px between them and no rule.
  //
  // YouTube's metadata reads "@handle • 2.7M subscribers". The channel FEED
  // carries neither, but YouTube's own page data does, so LocalTube captures
  // both whenever you visit a channel or watch one of its videos. Until that
  // happens — a channel imported from Takeout and never opened — the line falls
  // back to what the feed does know rather than inventing figures.
  for (const channel of ordered) {
    const row = document.createElement('div');
    row.className = 'lt-channel';
    row.dataset.channelId = channel.id;

    const initial = channel.title.trim().charAt(0).toUpperCase() || '?';
    const avatarLink = document.createElement('a');
    avatarLink.className = 'lt-channel-avatar';
    avatarLink.href = `/channel/${channel.id}`;
    const useInitial = (): void => {
      avatarLink.replaceChildren(document.createTextNode(initial));
      avatarLink.classList.add('lt-channel-avatar-initial');
    };
    if (channel.avatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.width = 136;
      img.height = 136;
      img.addEventListener('error', useInitial, { once: true });
      img.src = channel.avatar;
      avatarLink.appendChild(img);
    } else {
      useInitial();
    }

    const info = document.createElement('a');
    info.className = 'lt-channel-info';
    info.href = `/channel/${channel.id}`;

    const name = document.createElement('div');
    name.className = 'lt-channel-name';
    name.textContent = isPlaceholderTitle(channel) ? t('channel_name_loading') : channel.title;

    const meta = document.createElement('div');
    meta.className = 'lt-channel-meta';
    const entry = cache[channel.id];
    const known = [channel.handle, channel.subscribers].filter(Boolean).join(' • ');
    if (known) {
      meta.textContent = known;
    } else if (entry?.error) {
      meta.classList.add('lt-row-warn');
      meta.textContent = t('feed_unavailable', entry.error);
    } else if (entry && entry.videos.length > 0) {
      const latest = entry.videos[0];
      meta.textContent = `${videoCountLabel(entry.videos.length, !!entry.deep)} • ${t('latest_label', timeAgo(latest.published))}`;
    } else {
      meta.textContent = entry ? t('no_recent_uploads') : t('not_loaded_yet');
    }

    // With the handle line above taking the metadata slot, the feed status
    // moves down to where YouTube puts the channel description.
    const followedOn = document.createElement('div');
    followedOn.className = 'lt-channel-desc';
    const feedNote = entry?.error
      ? t('feed_unavailable', entry.error)
      : entry && entry.videos.length > 0
        ? `${videoCountLabel(entry.videos.length, !!entry.deep)} • ${t('latest_label', timeAgo(entry.videos[0].published))}`
        : entry
          ? t('no_recent_uploads')
          : t('not_loaded_yet');
    // The raw "ago" string is kept on the element so the handle-backfill patch
    // below can rebuild this line without parsing back translated text.
    const followedAgo = timeAgo(new Date(channel.addedAt).toISOString());
    followedOn.dataset.followedAgo = followedAgo;
    followedOn.textContent = known
      ? `${feedNote} • ${t('followed_lower_label', followedAgo)}`
      : t('followed_label', followedAgo);
    if (known && entry?.error) followedOn.classList.add('lt-row-warn');

    info.append(name, meta, followedOn);

    // Unfollowing is a write: read-only mode leaves the row itself, which is
    // a fact about local data, but not the control that changes it.
    if (writable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lt-channel-btn lt-accent';
      remove.setAttribute('aria-pressed', 'true');
      remove.textContent = t('subscribed_label');
      remove.title = t('subscribed_title');
      remove.addEventListener('click', async () => {
        await unsubscribe(channel.id);
        rerender();
      });

      // Older videos, on request only. The Atom feed carries 15, so without
      // this a channel you follow but never open contributes 15 videos and no
      // more — and this is far too expensive (~1 MB per 30 videos) to ever
      // run on its own. See lib/deep-history.ts.
      const deepen = document.createElement('button');
      deepen.type = 'button';
      deepen.className = 'lt-channel-btn lt-channel-btn-quiet';
      const deepened = entry?.deep === true;
      deepen.textContent = deepened ? t('load_more_older_videos') : t('load_older_videos');
      deepen.title = t('load_older_videos_title');
      deepen.addEventListener('click', async () => {
        deepen.disabled = true;
        const restore = deepen.textContent;
        deepen.textContent = t('loading_ellipsis');
        try {
          const result = await loadChannelHistory(channel.id, (loaded) => {
            deepen.textContent = t('loading_count', String(loaded));
          });
          if (result.rateLimited) flashToast(t('toast_rate_limited'));
          else if (result.added > 0)
            flashToast(t('toast_added_older_videos', [String(result.added), channel.title]));
          else flashToast(result.complete ? t('toast_nothing_older') : t('toast_no_new_videos'));
          rerender();
        } catch {
          deepen.textContent = restore;
          flashToast(t('toast_could_not_load_older'));
        } finally {
          deepen.disabled = false;
        }
      });

      const buttons = document.createElement('div');
      buttons.className = 'lt-channel-buttons';
      buttons.append(remove, deepen);
      row.append(avatarLink, info, buttons);
    } else {
      row.append(avatarLink, info);
    }
    rows.push({ channel, row });
    body.appendChild(row);
  }

  const heading = document.createElement('h1');
  heading.className = 'lt-page-title';
  heading.textContent = t('subscriptions_page_title');

  // YouTube's sort chip. Ours cycles rather than opening a menu — there are two
  // orders, and a menu for two options is a menu too many.
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'lt-chip';
  const chipLabel = document.createElement('span');
  chipLabel.textContent = sortLabel(channelSort);
  chip.append(chipLabel, icon(CHIP_CHEVRON, 24));
  chip.addEventListener('click', () => {
    channelSort = channelSort === 'recent' ? 'name' : 'recent';
    rerender();
  });

  // Filtering HIDES rows rather than rebuilding the list, so a "Load older
  // videos" run already in progress keeps its button, its progress text and
  // its disabled state instead of being replaced mid-fetch.
  const noMatches = emptyState(t('empty_no_matches_title'), t('empty_no_channel_match_body'));
  noMatches.hidden = true;
  const filter = searchField(t('filter_subscriptions_placeholder'), (value) => {
    const needle = needleOf(value);
    let matched = 0;
    for (const { channel, row } of rows) {
      const hit =
        !needle || `${channel.title} ${channel.handle ?? ''}`.toLowerCase().includes(needle);
      row.hidden = !hit;
      if (hit) matched++;
    }
    noMatches.hidden = matched > 0;
  });

  const chips = document.createElement('div');
  chips.className = 'lt-chips';
  if (subscriptions.length > 1) chips.append(filter, chip);

  const page = document.createElement('div');
  page.className = 'lt-subs-page';
  page.append(heading, chips, body, noMatches, localOnlyNote());

  root.replaceChildren(page);

  // Repair any channel still listed under its raw id — followed through a
  // collaboration button before its name could be looked up, or by an older
  // build that had no lookup at all. Runs after the view is on screen.
  if (subscriptions.some(isPlaceholderTitle)) {
    void resolveAllTitles().then((fixed) => {
      if (fixed > 0) rerender();
    });
  }

  // Learn the @handle of anything that has none — a channel imported from
  // Takeout, or followed before LocalTube captured handles at all. One small
  // oEmbed request each, off the feed cache, and only ever for the ones
  // missing it.
  //
  // Patched into the rows already on screen rather than re-rendering: this
  // resolves one channel at a time over a second or two, and a full re-render
  // per answer would make the list jump under the cursor.
  void backfillHandles(cache, (channelId, handle) => {
    const row = body.querySelector(`[data-channel-id="${CSS.escape(channelId)}"]`);
    const line = row?.querySelector('.lt-channel-meta');
    if (!line || line.textContent?.startsWith('@')) return;
    const status = line.textContent ?? '';
    line.textContent = handle;
    line.classList.remove('lt-row-warn');
    // The feed status the handle displaced moves down to the description line,
    // where it sits for every other channel that knows its handle.
    const desc = row?.querySelector<HTMLElement>('.lt-channel-desc');
    const followedAgo = desc?.dataset.followedAgo;
    if (desc && status && followedAgo) desc.textContent = `${status} • ${t('followed_lower_label', followedAgo)}`;
  }).catch(() => undefined);

  // Learn the avatar of anything that has none — Takeout carries none, and
  // neither the feed nor oEmbed has one, so an imported list starts as bare
  // initials. One small Innertube browse call each (channels browsing already
  // surfaced get theirs for free from the card harvest), patched into the row
  // when it lands, the same as the handle above.
  void backfillAvatars((channelId, avatar) => {
    const row = body.querySelector(`[data-channel-id="${CSS.escape(channelId)}"]`);
    const slot = row?.querySelector('.lt-channel-avatar');
    if (!slot || slot.querySelector('img')) return;
    // The initial the row currently shows, kept so a broken image can fall
    // back to it exactly as the render path's does.
    const initial = slot.textContent ?? '?';
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.width = 136;
    img.height = 136;
    img.addEventListener('error', () => {
      slot.replaceChildren(document.createTextNode(initial));
      slot.classList.add('lt-channel-avatar-initial');
    }, { once: true });
    img.src = avatar;
    slot.classList.remove('lt-channel-avatar-initial');
    slot.replaceChildren(img);
  }).catch(() => undefined);
}

/* ------------------------------------------------------------ playlists */

/**
 * The playlist index, laid out like YouTube's own /feed/playlists: a grid of
 * lockups, each a 16:9 cover with two stacked layers behind it, a "N videos"
 * badge in the corner, the name, and a metadata line.
 *
 * The stack layers are what make a playlist read as a playlist rather than a
 * video, so they are drawn even when there is no cover to stack behind.
 */
export async function playlistsView(root: HTMLElement, rerender: () => void): Promise<void> {
  const playlists = await listPlaylists();

  const heading = document.createElement('h1');
  heading.className = 'lt-page-title';
  heading.textContent = t('playlists_page_title');

  // The page's one action sits beside its title rather than in a bar of its own.
  const titleRow = document.createElement('div');
  titleRow.className = 'lt-title-row';
  titleRow.appendChild(heading);

  // Creating a playlist is a write: hidden in read-only mode.
  if (writesAllowed()) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'lt-btn lt-btn-primary';
    create.textContent = t('action_new_playlist');
    create.addEventListener('click', async () => {
      const name = prompt(t('prompt_playlist_name'));
      if (name === null) return;
      await createPlaylist(name);
      rerender();
    });
    titleRow.appendChild(create);
  }

  const body = document.createElement('div');
  body.className = 'lt-plgrid';
  for (const playlist of playlists) body.appendChild(playlistCard(playlist, rerender));

  root.replaceChildren(titleRow, body, localOnlyNote());
}

/** YouTube's own 12px playlist glyph, used on the video-count badge. */
const PLAYLIST_BADGE =
  'M8 7.697a.25.25 0 01.38-.213l2.87 1.766-2.87 1.766a.25.25 0 01-.38-.213V7.697ZM7 9.5H2a.5.5 0 010-1h5v1Zm3-4a.5.5 0 010 1H2a.5.5 0 010-1h8Zm0-3a.5.5 0 010 1H2a.5.5 0 010-1h8Z';

function playlistCard(playlist: Playlist, rerender: () => void): HTMLElement {
  const card = document.createElement('div');
  card.className = 'lt-pl-card';

  const open = (event: Event): void => {
    event.preventDefault();
    go({ name: 'playlist', id: playlist.id });
  };
  const href = viewHash({ name: 'playlist', id: playlist.id });

  const cover = document.createElement('a');
  cover.className = 'lt-pl-cover';
  cover.href = href;
  cover.addEventListener('click', open);

  // Two layers above the cover, the way YouTube stacks a collection.
  for (const depth of [2, 1]) {
    const layer = document.createElement('div');
    layer.className = `lt-pl-layer lt-pl-layer-${depth}`;
    cover.appendChild(layer);
  }

  const thumb = document.createElement('div');
  thumb.className = 'lt-pl-thumb';
  const first = playlist.videos[0];
  if (first) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = first.thumbnail;
    thumb.appendChild(img);
  }

  const badge = document.createElement('div');
  badge.className = 'lt-pl-badge';
  badge.appendChild(icon(PLAYLIST_BADGE, 12));
  const count = document.createElement('span');
  count.textContent =
    playlist.videos.length === 0 ? t('no_videos_label') : t('videos_count_label', String(playlist.videos.length));
  badge.appendChild(count);
  thumb.appendChild(badge);
  cover.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'lt-pl-meta';

  const title = document.createElement('a');
  title.className = 'lt-pl-title';
  title.href = href;
  title.title = playlist.name;
  title.textContent = playlist.name;
  title.addEventListener('click', open);

  // YouTube reads "Private • Playlist" here. "Local" is the honest version of
  // the same fact: this list exists in this browser and nowhere else.
  const sub = document.createElement('div');
  sub.className = 'lt-pl-sub';
  sub.textContent = t('local_playlist_label');

  const full = document.createElement('a');
  full.className = 'lt-pl-open';
  full.href = href;
  full.textContent = t('action_view_full_playlist');
  full.addEventListener('click', open);

  meta.append(title, sub, full);
  card.append(cover, meta);

  // System playlists (Watch Later, Liked) cannot be renamed or deleted, and
  // neither of these is a write the read-only mode allows anyway.
  if (!playlist.system && writesAllowed()) {
    const actions = document.createElement('div');
    actions.className = 'lt-pl-actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'lt-card-action';
    rename.textContent = t('action_rename');
    rename.addEventListener('click', async () => {
      const name = prompt(t('prompt_playlist_name'), playlist.name);
      if (name === null) return;
      await renamePlaylist(playlist.id, name);
      rerender();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-card-action';
    remove.textContent = t('action_delete');
    remove.addEventListener('click', async () => {
      if (!confirm(t('confirm_delete_playlist', playlist.name))) return;
      await deletePlaylist(playlist.id);
      rerender();
    });

    actions.append(rename, remove);
    card.appendChild(actions);
  }
  return card;
}

/* ------------------------------------------------------- playlist detail */

/**
 * One row of a playlist, in the shape YouTube's newer lockup renderer has —
 * measured on a live /playlist?list=LL: a 200x112.5 cover at 8px radius, 8px to
 * the text, a 500 14px/20px title clamped to two lines, then metadata rows of
 * 12px/18px with 2px between them, and a 40x40 action at the top right.
 *
 * Watch Later is still served by YouTube's older numbered renderer, but the
 * lockup is where it is going, and one row shape for every LocalTube playlist
 * beats matching two.
 */
function playlistVideoRow(
  video: Video,
  onRemove: (video: Video) => void | Promise<void>,
  watched?: ProgressEntry,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lt-lockup';

  const href = watchHref(video.id, watched);

  const cover = document.createElement('a');
  cover.className = 'lt-lockup-cover';
  cover.href = href;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = video.thumbnail;
  cover.appendChild(img);
  const badge = durationBadge(video.duration ?? watched?.duration);
  if (badge) cover.appendChild(badge);
  const bar = progressBar(watchedFraction(watched));
  if (bar) cover.appendChild(bar);

  const meta = document.createElement('div');
  meta.className = 'lt-lockup-meta';

  const title = document.createElement('a');
  title.className = 'lt-lockup-title';
  title.href = href;
  title.title = video.title;
  title.textContent = video.title;
  meta.appendChild(title);

  if (video.channelTitle) {
    const channel = document.createElement('div');
    channel.className = 'lt-lockup-row';
    channel.textContent = video.channelTitle;
    meta.appendChild(channel);
  }

  const stats = [formatViews(video.views), timeAgo(video.published)].filter(Boolean);
  if (stats.length > 0) {
    const line = document.createElement('div');
    line.className = 'lt-lockup-row';
    line.textContent = stats.join(' • ');
    meta.appendChild(line);
  }

  // Removing from the playlist is a write; the kebab survives as Share.
  const menu = kebab(
    video,
    writesAllowed()
      ? [{ label: t('action_remove_from_playlist'), path: PATHS.trash, onClick: () => void onRemove(video) }]
      : [],
  );
  menu.classList.add('lt-lockup-action');

  row.append(cover, meta, menu);
  return row;
}

/** When the playlist last gained a video, for the panel's "Updated" line. */
function lastUpdated(playlist: Playlist): number {
  return playlist.videos.reduce((newest, video) => Math.max(newest, video.addedAt ?? 0), playlist.createdAt);
}

export async function playlistView(root: HTMLElement, id: string, rerender: () => void): Promise<void> {
  const playlist = await getPlaylist(id);
  if (!playlist) {
    root.replaceChildren(
      emptyState(t('empty_playlist_not_found_title'), t('empty_playlist_not_found_body'), {
        label: t('action_back_to_playlists'),
        onClick: () => go({ name: 'playlists' }),
      }),
    );
    return;
  }

  const cover = playlist.videos[0]?.thumbnail;

  /* ------------------------------------------------------------ the panel */

  const panel = document.createElement('div');
  panel.className = 'lt-plpanel';

  // The blurred cover behind the panel, as YouTube's immersive header does it.
  // Both layers are decorative and sit under the content.
  if (cover) {
    const backdrop = document.createElement('div');
    backdrop.className = 'lt-plpanel-bg';
    backdrop.style.backgroundImage = `url("${cover}")`;
    panel.appendChild(backdrop);
  }
  const wash = document.createElement('div');
  wash.className = 'lt-plpanel-wash';
  panel.appendChild(wash);

  const inner = document.createElement('div');
  inner.className = 'lt-plpanel-inner';

  if (cover) {
    const art = document.createElement('div');
    art.className = 'lt-plpanel-cover';
    const img = document.createElement('img');
    img.alt = '';
    img.src = cover;
    art.appendChild(img);
    inner.appendChild(art);
  }

  const name = document.createElement('h1');
  name.className = 'lt-plpanel-title';
  name.textContent = playlist.name;

  const owner = document.createElement('div');
  owner.className = 'lt-plpanel-owner';
  // A copied playlist says so. It is an ordinary local playlist from here on —
  // nothing syncs on its own — and the line is what keeps that from reading as
  // a live connection to the YouTube one.
  owner.textContent = playlist.sourcePlaylistId ? t('playlist_owner_copied') : 'LocalTube';

  const stats = document.createElement('div');
  stats.className = 'lt-plpanel-stats';
  stats.textContent = [
    t('videos_count_label', String(playlist.videos.length)),
    t('updated_label', timeAgo(new Date(lastUpdated(playlist)).toISOString()) || t('just_now')),
  ].join(' · ');

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'lt-plbtn lt-plbtn-filled';
  play.append(icon(PATHS.play), document.createTextNode(t('action_play_all')));
  play.disabled = playlist.videos.length === 0;
  play.addEventListener('click', () => {
    clearShuffle(playlist.id);
    // The queue id travels in the hash so it survives navigation without
    // colliding with YouTube's own `list=` parameter.
    location.href = `/watch?v=${encodeURIComponent(playlist.videos[0].id)}#localtube-queue=${playlist.id}`;
  });

  const shuffle = document.createElement('button');
  shuffle.type = 'button';
  shuffle.className = 'lt-plbtn lt-plbtn-tonal';
  shuffle.append(icon(PATHS.shuffle), document.createTextNode(t('action_shuffle')));
  shuffle.disabled = playlist.videos.length === 0;
  shuffle.addEventListener('click', () => {
    // A real shuffle, not a random starting point: the order is written for
    // this tab and the queue advances through it.
    const order = shuffled(playlist.videos.map((video) => video.id));
    writeShuffle(playlist.id, order);
    location.href = `/watch?v=${encodeURIComponent(order[0])}#localtube-queue=${playlist.id}`;
  });

  const buttons = document.createElement('div');
  buttons.className = 'lt-plpanel-buttons';
  buttons.append(play, shuffle);

  inner.append(name, owner, stats, buttons);

  // Renaming and deleting live here rather than on a card, now that a playlist
  // has a page of its own to own them. Both are writes: read-only mode shows
  // the playlist but not these links.
  if (!playlist.system && writesAllowed()) {
    const manage = document.createElement('div');
    manage.className = 'lt-plpanel-manage';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'lt-plpanel-link';
    rename.textContent = t('action_rename');
    rename.addEventListener('click', async () => {
      const next = prompt(t('prompt_playlist_name'), playlist.name);
      if (next === null) return;
      await renamePlaylist(playlist.id, next);
      rerender();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-plpanel-link';
    remove.textContent = t('action_delete');
    remove.addEventListener('click', async () => {
      if (!confirm(t('confirm_delete_playlist', playlist.name))) return;
      await deletePlaylist(playlist.id);
      go({ name: 'playlists' });
    });

    manage.append(rename, remove);

    // Only for a playlist copied from YouTube, and only when the page can
    // still reach Innertube: re-reading it here saves going back to the
    // YouTube playlist to press Save again. The same one-shot read as the
    // button there — there is no sync loop behind either of them.
    if (playlist.sourcePlaylistId && innertubeAvailable()) {
      const sourceId = playlist.sourcePlaylistId;
      const update = document.createElement('button');
      update.type = 'button';
      update.className = 'lt-plpanel-link';
      update.textContent = t('action_update_from_youtube');
      update.addEventListener('click', async () => {
        update.disabled = true;
        showToast(t('toast_reading_playlist'), { spinner: true });
        try {
          const result = await savePlaylistFromYouTube(sourceId, (loaded) => {
            showToast(t('toast_reading_playlist_progress', String(loaded)), { spinner: true });
          });
          flashToast(
            result.added > 0
              ? t('toast_added_new_videos', String(result.added))
              : t('toast_already_up_to_date'),
          );
          rerender();
        } catch (error) {
          flashToast(
            error instanceof PlaylistUnavailable ? error.message : t('toast_could_not_read_playlist'),
            4000,
            { error: true },
          );
        } finally {
          update.disabled = false;
        }
      });
      manage.appendChild(update);
    }

    inner.appendChild(manage);
  }

  panel.appendChild(inner);

  /* ------------------------------------------------------------- the list */

  const removeVideo = async (video: Video): Promise<void> => {
    await removeFromPlaylist(playlist.id, video.id);
    rerender();
  };

  const list = document.createElement('div');
  list.className = 'lt-lockups';
  const watched = progressFor(await listProgress());

  const paintRows = (query: string): void => {
    if (playlist.videos.length === 0) {
      list.replaceChildren(emptyState(t('empty_playlist_nothing_saved_title'), t('empty_playlist_nothing_saved_body')));
      return;
    }
    const needle = needleOf(query);
    const shown = playlist.videos.filter((video) => videoMatches(video, needle));
    if (shown.length === 0) {
      list.replaceChildren(
        emptyState(t('empty_no_matches_title'), t('empty_playlist_no_matches_body', query.trim())),
      );
      return;
    }
    list.replaceChildren(
      ...shown.map((video) => playlistVideoRow(video, removeVideo, watched(video.id))),
    );
  };
  paintRows('');

  const column = document.createElement('div');
  column.className = 'lt-plcolumn';
  // Only worth a filter box once the list is long enough to need one; a
  // playlist of four is faster to read than to type into.
  if (playlist.videos.length > 8) {
    const bar = document.createElement('div');
    bar.className = 'lt-plsearch';
    bar.appendChild(searchField(t('filter_playlist_placeholder'), paintRows));
    column.appendChild(bar);
  }
  column.appendChild(list);

  const layout = document.createElement('div');
  layout.className = 'lt-pldetail';
  layout.append(panel, column);

  root.replaceChildren(layout, localOnlyNote());
}

/* --------------------------------------------------------------- history */

/** Day heading for a watch time: Today, Yesterday, then the date itself. */
function dayLabel(watchedAt: number): string {
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(watchedAt))) / 86_400_000);
  if (days <= 0) return t('day_today');
  if (days === 1) return t('day_yesterday');
  return new Date(watchedAt).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function historyRow(
  entry: HistoryEntry,
  onRemove: (video: Video) => void | Promise<void>,
  watched?: ProgressEntry,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lt-histrow';

  const href = watchHref(entry.id, watched);

  const cover = document.createElement('a');
  cover.className = 'lt-histrow-cover';
  cover.href = href;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = entry.thumbnail;
  cover.appendChild(img);
  const badge = durationBadge(entry.duration ?? watched?.duration);
  if (badge) cover.appendChild(badge);
  const bar = progressBar(watchedFraction(watched));
  if (bar) cover.appendChild(bar);

  const meta = document.createElement('div');
  meta.className = 'lt-histrow-meta';

  const title = document.createElement('a');
  title.className = 'lt-histrow-title';
  title.href = href;
  title.title = entry.title;
  title.textContent = entry.title;

  const menu = kebab(
    entry,
    writesAllowed()
      ? [{ label: t('action_remove_from_history'), path: PATHS.trash, onClick: () => void onRemove(entry) }]
      : [],
  );
  menu.classList.add('lt-histrow-remove');

  // Title and action share one row, the way YouTube's title-wrapper holds the
  // headline and its kebab menu.
  const head = document.createElement('div');
  head.className = 'lt-histrow-head';
  head.append(title, menu);

  // One metadata line, not two: YouTube's row carries a single 18px line, and
  // the day grouping already says roughly when this was.
  const byline = document.createElement('div');
  byline.className = 'lt-histrow-byline';
  byline.textContent = [
    entry.channelTitle,
    formatViews(entry.views),
    t('watched_label', timeAgo(new Date(entry.watchedAt).toISOString())),
  ]
    .filter(Boolean)
    .join(' • ');

  meta.append(head, byline);

  row.append(cover, meta);
  return row;
}

/** One rail action: a 24px icon and a label, as YouTube's History rail has. */
function railAction(label: string, path: string, onClick: () => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lt-rail-action';
  button.appendChild(icon(path));
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener('click', onClick);
  return button;
}

export async function historyView(root: HTMLElement, rerender: () => void): Promise<void> {
  const [history, enabled, progress] = await Promise.all([
    listHistory(),
    historyEnabled(),
    listProgress(),
  ]);
  const watched = progressFor(progress);

  const title = document.createElement('h1');
  title.className = 'lt-page-title';
  title.textContent = t('history_page_title');

  /* ------------------------------------------------------------- the rail */

  const search = document.createElement('div');
  search.className = 'lt-rail-search';
  search.appendChild(icon(PATHS.search));
  const field = document.createElement('input');
  field.type = 'search';
  field.placeholder = t('search_history_placeholder');
  field.setAttribute('aria-label', t('search_history_placeholder'));
  search.appendChild(field);

  const rail = document.createElement('aside');
  rail.className = 'lt-rail';
  rail.appendChild(search);

  // Clearing and pausing both change what gets written — read-only mode shows
  // the history but neither of these controls.
  if (writesAllowed()) {
    const clear = railAction(t('action_clear_history'), PATHS.trash, async () => {
      if (!confirm(t('confirm_clear_history'))) return;
      await clearHistory();
      rerender();
    });
    if (history.length === 0) (clear as HTMLButtonElement).disabled = true;

    const pause = railAction(
      enabled ? t('action_pause_history') : t('action_resume_history'),
      enabled ? PATHS.pause : PATHS.play,
      async () => {
        await setHistoryEnabled(!enabled);
        rerender();
      },
    );
    rail.append(clear, pause);
  }

  const note = document.createElement('p');
  note.className = 'lt-rail-note';
  note.textContent = enabled ? t('history_note_enabled', String(HISTORY_LIMIT)) : t('history_note_paused');
  rail.appendChild(note);

  /* ------------------------------------------------------------- the list */

  const list = document.createElement('div');
  list.className = 'lt-hist-list';

  const remove = async (video: Video): Promise<void> => {
    await removeFromHistory(video.id);
    rerender();
  };

  // Re-painted on every keystroke rather than re-read from storage: filtering is
  // a view concern, and a storage round-trip per character would be visible.
  const paint = (query: string): void => {
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? history.filter((entry) =>
          `${entry.title} ${entry.channelTitle}`.toLowerCase().includes(needle),
        )
      : history;

    if (shown.length === 0) {
      list.replaceChildren(
        needle
          ? emptyState(t('empty_no_matches_title'), t('empty_history_no_matches_body', query.trim()))
          : emptyState(
              enabled ? t('empty_history_title') : t('empty_history_paused_title'),
              enabled ? t('empty_history_body') : t('empty_history_paused_body'),
            ),
      );
      return;
    }

    // Grouped by the day it was watched, the way YouTube groups its own.
    const groups: [string, HistoryEntry[]][] = [];
    for (const entry of shown) {
      const label = dayLabel(entry.watchedAt);
      const last = groups[groups.length - 1];
      if (last && last[0] === label) last[1].push(entry);
      else groups.push([label, [entry]]);
    }

    const rendered: HTMLElement[] = [];
    for (const [label, entries] of groups) {
      const heading = document.createElement('h2');
      heading.className = 'lt-hist-day';
      heading.textContent = label;
      rendered.push(heading);
      for (const entry of entries) rendered.push(historyRow(entry, remove, watched(entry.id)));
    }
    list.replaceChildren(...rendered);
  };

  field.addEventListener('input', () => paint(field.value));
  paint('');

  const layout = document.createElement('div');
  layout.className = 'lt-hist-layout';
  layout.append(list, rail);

  // Tabs, title and columns share one centred block, so all three line up —
  // which is how YouTube's two-column pages are built. Leaving the tabs outside
  // it left them starting 90px to the left of the heading they belong to.
  const page = document.createElement('div');
  page.className = 'lt-hist-page';
  page.append(title, layout);

  root.replaceChildren(page);
}
