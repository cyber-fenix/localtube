// The LocalTube views. They render into a container the content script
// mounts inside YouTube's home page; nothing here knows about YouTube's DOM.

import { loadFeed, type FeedStatus } from '@/lib/feed';
import { deletePlaylist, getPlaylist, listPlaylists, removeFromPlaylist, renamePlaylist, createPlaylist } from '@/lib/playlists';
import { clearHistory, historyEnabled, listHistory, removeFromHistory, setHistoryEnabled } from '@/lib/history';
import { HISTORY_LIMIT, getData, getFeedCache } from '@/lib/store';
import { isPlaceholderTitle, listSubscriptions, resolveAllTitles, unsubscribe } from '@/lib/subscriptions';
import { emptyState, formatViews, timeAgo, videoGrid } from '@/ui/cards';
import { PATHS, icon } from '@/ui/icons';
import { clearShuffle, shuffled, writeShuffle } from '@/lib/shuffle';
import type { HistoryEntry, Playlist, Video } from '@/types';

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

function header(active: View['name'], extra?: HTMLElement[]): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'lt-header';

  const tabs: [View, string][] = [
    [{ name: 'feed' }, 'Feed'],
    [{ name: 'subscriptions' }, 'Subscriptions'],
    [{ name: 'playlists' }, 'Playlists'],
    [{ name: 'history' }, 'History'],
  ];
  for (const [view, label] of tabs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'lt-tab';
    tab.textContent = label;
    // A playlist detail page — including Watch Later and Liked — is "inside"
    // Playlists, so keep that tab lit.
    const inPlaylists = active === 'playlist' || active === 'watch-later' || active === 'liked';
    const isActive = view.name === active || (inPlaylists && view.name === 'playlists');
    tab.setAttribute('aria-selected', String(isActive));
    tab.addEventListener('click', () => go(view));
    bar.appendChild(tab);
  }

  const spacer = document.createElement('div');
  spacer.className = 'lt-spacer';
  bar.appendChild(spacer);
  if (extra) bar.append(...extra);
  return bar;
}

function localOnlyNote(): HTMLElement {
  const note = document.createElement('p');
  note.className = 'lt-note';
  note.textContent =
    'LocalTube subscriptions, likes and playlists are stored in this browser only. They are not connected to a Google account and do not affect YouTube recommendations.';
  return note;
}

/* ----------------------------------------------------------------- feed */

export async function feedView(root: HTMLElement, token: () => boolean): Promise<void> {
  // The avatar YouTube shows beside each title. We have one only for channels
  // you follow — which, on a feed built from your follows, is all of them.
  const { subscriptions } = await getData();
  const avatarFor = (video: Video): string | undefined => subscriptions[video.channelId]?.avatar;

  const status = document.createElement('span');
  status.className = 'lt-status';

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'lt-btn';
  refresh.textContent = 'Refresh';

  // Built detached and attached in a single swap on the first paint. Attaching
  // an empty body first and filling it after the await left the page visibly
  // blank for three storage round-trips on every switch to this tab.
  const body = document.createElement('div');
  const bar = header('feed', [status, refresh]);
  const note = localOnlyNote();
  let attached = false;
  const attach = (): void => {
    if (attached) return;
    attached = true;
    root.replaceChildren(bar, body, note);
  };

  let shown = PAGE_SIZE;
  let latest: Video[] = [];

  const paint = (videos: Video[], feedStatus: FeedStatus): void => {
    if (!token()) return;
    latest = videos;
    status.textContent =
      feedStatus.done < feedStatus.refreshing
        ? `Updating ${feedStatus.done}/${feedStatus.refreshing} channels…`
        : feedStatus.failed.length > 0
          ? `${feedStatus.failed.length} channel${feedStatus.failed.length === 1 ? '' : 's'} could not be loaded`
          : '';

    if (videos.length === 0) {
      body.replaceChildren(
        emptyState(
          'Your feed is empty',
          'Follow a few channels with the LocalTube button on any channel or video page, or import your existing subscriptions from a Google Takeout file in the extension popup.',
          { label: 'View subscriptions', onClick: () => go({ name: 'subscriptions' }) },
        ),
      );
      return;
    }

    const grid = videoGrid(videos.slice(0, shown), undefined, { avatar: avatarFor });
    body.replaceChildren(grid);
    if (videos.length > shown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'lt-btn';
      more.style.margin = '24px auto';
      more.style.display = 'block';
      more.textContent = 'Load more';
      more.addEventListener('click', () => {
        shown += PAGE_SIZE;
        paint(latest, feedStatus);
      });
      body.appendChild(more);
    }
    attach();
  };

  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void loadFeed(paint, { force: true }).finally(() => {
      refresh.disabled = false;
    });
  });

  await loadFeed(paint);
  // loadFeed always paints at least once, but never leave the view unattached.
  attach();
}

/* -------------------------------------------------------- subscriptions */

/** How the channel list is ordered. YouTube's chip says "Most relevant"; ours
 *  says what it actually does, because there is no relevance model here. */
type ChannelSort = 'recent' | 'name';
const SORT_LABEL: Record<ChannelSort, string> = {
  recent: 'Recently followed',
  name: 'Name (A–Z)',
};
let channelSort: ChannelSort = 'recent';

/** YouTube's chevron, as it appears at the end of a chip. */
const CHIP_CHEVRON = 'M18.707 8.793a1 1 0 00-1.414 0L12 14.086 6.707 8.793a1 1 0 10-1.414 1.414L12 16.914l6.707-6.707a1 1 0 000-1.414Z';

export async function subscriptionsView(root: HTMLElement, rerender: () => void): Promise<void> {
  const [subscriptions, cache] = await Promise.all([listSubscriptions(), getFeedCache()]);

  const ordered = subscriptions.slice().sort((a, b) => {
    if (channelSort === 'name') return a.title.localeCompare(b.title);
    return b.addedAt - a.addedAt;
  });

  const body = document.createElement('div');
  body.className = 'lt-channels';

  if (subscriptions.length === 0) {
    body.appendChild(
      emptyState(
        'No channels yet',
        'Open any YouTube channel or video and use the LocalTube follow button. To bring over an existing account, import a Google Takeout subscriptions.csv from the extension popup.',
      ),
    );
  }

  // Laid out like YouTube's own /feed/channels, measured on a live page: a
  // 136px avatar with 16px to the text, a 400 18px/26px name with 8px beneath
  // it, a 12px/18px metadata line with 4px beneath it, a two-line description,
  // and the follow control in a block on the right. Rows are 136 tall with
  // 16px between them and no rule.
  //
  // YouTube's metadata reads "@handle • 2.7M subscribers". LocalTube has
  // neither — both come from YouTube's API and the public channel feed carries
  // no trace of either — so the line says what is actually known instead of
  // inventing figures.
  for (const channel of ordered) {
    const row = document.createElement('div');
    row.className = 'lt-channel';

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
    name.textContent = isPlaceholderTitle(channel) ? 'Loading channel name…' : channel.title;

    const meta = document.createElement('div');
    meta.className = 'lt-channel-meta';
    const entry = cache[channel.id];
    if (entry?.error) {
      meta.classList.add('lt-row-warn');
      meta.textContent = `Feed unavailable (${entry.error}) — the channel may have been deleted`;
    } else if (entry && entry.videos.length > 0) {
      const latest = entry.videos[0];
      meta.textContent = `${entry.videos.length} recent videos • latest ${timeAgo(latest.published)}`;
    } else {
      meta.textContent = entry ? 'No recent uploads' : 'Not loaded yet';
    }

    const followedOn = document.createElement('div');
    followedOn.className = 'lt-channel-desc';
    followedOn.textContent = `Followed ${timeAgo(new Date(channel.addedAt).toISOString())}`;

    info.append(name, meta, followedOn);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-channel-btn lt-accent';
    remove.setAttribute('aria-pressed', 'true');
    remove.textContent = 'Subscribed';
    remove.title = 'Following in LocalTube — click to unfollow';
    remove.addEventListener('click', async () => {
      await unsubscribe(channel.id);
      rerender();
    });

    const buttons = document.createElement('div');
    buttons.className = 'lt-channel-buttons';
    buttons.appendChild(remove);

    row.append(avatarLink, info, buttons);
    body.appendChild(row);
  }

  const heading = document.createElement('h1');
  heading.className = 'lt-page-title';
  heading.textContent = 'All subscriptions';

  // YouTube's sort chip. Ours cycles rather than opening a menu — there are two
  // orders, and a menu for two options is a menu too many.
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'lt-chip';
  const chipLabel = document.createElement('span');
  chipLabel.textContent = SORT_LABEL[channelSort];
  chip.append(chipLabel, icon(CHIP_CHEVRON, 24));
  chip.addEventListener('click', () => {
    channelSort = channelSort === 'recent' ? 'name' : 'recent';
    rerender();
  });

  const chips = document.createElement('div');
  chips.className = 'lt-chips';
  if (subscriptions.length > 1) chips.appendChild(chip);

  const page = document.createElement('div');
  page.className = 'lt-subs-page';
  page.append(header('subscriptions'), heading, chips, body, localOnlyNote());

  root.replaceChildren(page);

  // Repair any channel still listed under its raw id — followed through a
  // collaboration button before its name could be looked up, or by an older
  // build that had no lookup at all. Runs after the view is on screen.
  if (subscriptions.some(isPlaceholderTitle)) {
    void resolveAllTitles().then((fixed) => {
      if (fixed > 0) rerender();
    });
  }
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

  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'lt-btn lt-btn-primary';
  create.textContent = 'New playlist';
  create.addEventListener('click', async () => {
    const name = prompt('Playlist name');
    if (name === null) return;
    await createPlaylist(name);
    rerender();
  });

  const heading = document.createElement('h1');
  heading.className = 'lt-page-title';
  heading.textContent = 'Playlists';

  const body = document.createElement('div');
  body.className = 'lt-plgrid';
  for (const playlist of playlists) body.appendChild(playlistCard(playlist, rerender));

  root.replaceChildren(header('playlists', [create]), heading, body, localOnlyNote());
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
    playlist.videos.length === 0
      ? 'No videos'
      : `${playlist.videos.length} video${playlist.videos.length === 1 ? '' : 's'}`;
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
  sub.textContent = 'Local • Playlist';

  const full = document.createElement('a');
  full.className = 'lt-pl-open';
  full.href = href;
  full.textContent = 'View full playlist';
  full.addEventListener('click', open);

  meta.append(title, sub, full);
  card.append(cover, meta);

  // System playlists (Watch Later, Liked) cannot be renamed or deleted.
  if (!playlist.system) {
    const actions = document.createElement('div');
    actions.className = 'lt-pl-actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'lt-card-action';
    rename.textContent = 'Rename';
    rename.addEventListener('click', async () => {
      const name = prompt('Playlist name', playlist.name);
      if (name === null) return;
      await renamePlaylist(playlist.id, name);
      rerender();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-card-action';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
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
function playlistVideoRow(video: Video, onRemove: (video: Video) => void | Promise<void>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lt-lockup';

  const href = `/watch?v=${encodeURIComponent(video.id)}`;

  const cover = document.createElement('a');
  cover.className = 'lt-lockup-cover';
  cover.href = href;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = video.thumbnail;
  cover.appendChild(img);

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

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'lt-lockup-action';
  remove.title = 'Remove from this playlist';
  remove.setAttribute('aria-label', 'Remove from this playlist');
  remove.textContent = 'Remove';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    void onRemove(video);
  });

  row.append(cover, meta, remove);
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
      header('playlists'),
      emptyState('Playlist not found', 'It may have been deleted from another tab.', {
        label: 'Back to playlists',
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
  owner.textContent = 'LocalTube';

  const stats = document.createElement('div');
  stats.className = 'lt-plpanel-stats';
  stats.textContent = [
    `${playlist.videos.length} video${playlist.videos.length === 1 ? '' : 's'}`,
    `Updated ${timeAgo(new Date(lastUpdated(playlist)).toISOString()) || 'just now'}`,
  ].join(' · ');

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'lt-plbtn lt-plbtn-filled';
  play.append(icon(PATHS.play), document.createTextNode('Play all'));
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
  shuffle.append(icon(PATHS.shuffle), document.createTextNode('Shuffle'));
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
  // has a page of its own to own them.
  if (!playlist.system) {
    const manage = document.createElement('div');
    manage.className = 'lt-plpanel-manage';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'lt-plpanel-link';
    rename.textContent = 'Rename';
    rename.addEventListener('click', async () => {
      const next = prompt('Playlist name', playlist.name);
      if (next === null) return;
      await renamePlaylist(playlist.id, next);
      rerender();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-plpanel-link';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
      await deletePlaylist(playlist.id);
      go({ name: 'playlists' });
    });

    manage.append(rename, remove);
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
  if (playlist.videos.length === 0) {
    list.appendChild(
      emptyState('Nothing saved yet', 'Use the Save button under any video to add it here.'),
    );
  } else {
    for (const video of playlist.videos) list.appendChild(playlistVideoRow(video, removeVideo));
  }

  const layout = document.createElement('div');
  layout.className = 'lt-pldetail';
  layout.append(panel, list);

  root.replaceChildren(header('playlist'), layout, localOnlyNote());
}

/* --------------------------------------------------------------- history */

/** Day heading for a watch time: Today, Yesterday, then the date itself. */
function dayLabel(watchedAt: number): string {
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(watchedAt))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(watchedAt).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function historyRow(entry: HistoryEntry, onRemove: (video: Video) => void | Promise<void>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lt-histrow';

  const href = `/watch?v=${encodeURIComponent(entry.id)}`;

  const cover = document.createElement('a');
  cover.className = 'lt-histrow-cover';
  cover.href = href;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = entry.thumbnail;
  cover.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'lt-histrow-meta';

  const title = document.createElement('a');
  title.className = 'lt-histrow-title';
  title.href = href;
  title.title = entry.title;
  title.textContent = entry.title;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'lt-histrow-remove';
  remove.title = 'Remove from watch history';
  remove.setAttribute('aria-label', 'Remove from watch history');
  remove.textContent = 'Remove';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    void onRemove(entry);
  });

  // Title and action share one row, the way YouTube's title-wrapper holds the
  // headline and its kebab menu.
  const head = document.createElement('div');
  head.className = 'lt-histrow-head';
  head.append(title, remove);

  // One metadata line, not two: YouTube's row carries a single 18px line, and
  // the day grouping already says roughly when this was.
  const byline = document.createElement('div');
  byline.className = 'lt-histrow-byline';
  byline.textContent = [
    entry.channelTitle,
    formatViews(entry.views),
    `watched ${timeAgo(new Date(entry.watchedAt).toISOString())}`,
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
  const [history, enabled] = await Promise.all([listHistory(), historyEnabled()]);

  const title = document.createElement('h1');
  title.className = 'lt-page-title';
  title.textContent = 'Watch history';

  /* ------------------------------------------------------------- the rail */

  const search = document.createElement('div');
  search.className = 'lt-rail-search';
  search.appendChild(icon(PATHS.search));
  const field = document.createElement('input');
  field.type = 'search';
  field.placeholder = 'Search watch history';
  field.setAttribute('aria-label', 'Search watch history');
  search.appendChild(field);

  const clear = railAction('Clear all watch history', PATHS.trash, async () => {
    if (!confirm('Clear your entire LocalTube watch history? This cannot be undone.')) return;
    await clearHistory();
    rerender();
  });
  if (history.length === 0) (clear as HTMLButtonElement).disabled = true;

  const pause = railAction(
    enabled ? 'Pause watch history' : 'Resume watch history',
    enabled ? PATHS.pause : PATHS.play,
    async () => {
      await setHistoryEnabled(!enabled);
      rerender();
    },
  );

  const rail = document.createElement('aside');
  rail.className = 'lt-rail';
  rail.append(search, clear, pause);

  const note = document.createElement('p');
  note.className = 'lt-rail-note';
  note.textContent = enabled
    ? `Added after ten seconds of playback. The last ${HISTORY_LIMIT} are kept, in this browser only — YouTube is never told what you watched.`
    : 'Recording is paused. Nothing new is being added.';
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
          ? emptyState('No matches', `Nothing in your history matches "${query.trim()}".`)
          : emptyState(
              enabled ? 'Nothing watched yet' : 'History is paused',
              enabled
                ? 'Videos you watch on YouTube will appear here, newest first. Nothing leaves this browser.'
                : 'Resume recording to start collecting watched videos again.',
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
      for (const entry of entries) rendered.push(historyRow(entry, remove));
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
  page.append(header('history', []), title, layout);

  root.replaceChildren(page);
}
