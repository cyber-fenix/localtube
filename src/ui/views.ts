// The four LocalTube views. They render into a container the content script
// mounts inside YouTube's home page; nothing here knows about YouTube's DOM.

import { loadFeed, type FeedStatus } from '@/lib/feed';
import { deletePlaylist, getPlaylist, listPlaylists, removeFromPlaylist, renamePlaylist, createPlaylist } from '@/lib/playlists';
import { getFeedCache } from '@/lib/store';
import { isPlaceholderTitle, listSubscriptions, resolveAllTitles, unsubscribe } from '@/lib/subscriptions';
import { emptyState, timeAgo, videoGrid } from '@/ui/cards';
import type { Playlist, Video } from '@/types';

export type View =
  | { name: 'feed' }
  | { name: 'subscriptions' }
  | { name: 'playlists' }
  | { name: 'playlist'; id: string };

const PAGE_SIZE = 60;

export const viewHash = (view: View): string =>
  view.name === 'playlist' ? `#localtube=playlist:${view.id}` : `#localtube=${view.name}`;

/** Parse `#localtube=...`. Returns null when the hash names no LocalTube view. */
export function parseViewHash(hash: string): View | null {
  const match = /#localtube=([^&]+)/.exec(hash);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  if (value === 'subscriptions' || value === 'playlists' || value === 'feed')
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
  ];
  for (const [view, label] of tabs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'lt-tab';
    tab.textContent = label;
    // A playlist detail page is "inside" Playlists, so keep that tab lit.
    const isActive = view.name === active || (active === 'playlist' && view.name === 'playlists');
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

    const grid = videoGrid(videos.slice(0, shown));
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

export async function subscriptionsView(root: HTMLElement, rerender: () => void): Promise<void> {
  const [subscriptions, cache] = await Promise.all([listSubscriptions(), getFeedCache()]);

  const body = document.createElement('div');
  body.className = 'lt-list';

  if (subscriptions.length === 0) {
    body.appendChild(
      emptyState(
        'No channels yet',
        'Open any YouTube channel or video and use the LocalTube follow button. To bring over an existing account, import a Google Takeout subscriptions.csv from the extension popup.',
      ),
    );
  }

  for (const channel of subscriptions) {
    const row = document.createElement('div');
    row.className = 'lt-row';

    if (channel.avatar) {
      const img = document.createElement('img');
      img.src = channel.avatar;
      img.alt = '';
      row.appendChild(img);
    }

    const main = document.createElement('div');
    main.className = 'lt-row-main';
    const link = document.createElement('a');
    link.className = 'lt-row-title';
    link.href = `/channel/${channel.id}`;
    link.textContent = isPlaceholderTitle(channel) ? 'Loading channel name…' : channel.title;
    const sub = document.createElement('div');
    sub.className = 'lt-row-sub';
    const entry = cache[channel.id];
    if (entry?.error) {
      sub.classList.add('lt-row-warn');
      sub.textContent = `Feed unavailable (${entry.error}) — the channel may have been deleted`;
    } else {
      sub.textContent = entry ? `${entry.videos.length} recent videos` : 'Not loaded yet';
    }
    main.append(link, sub);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-btn';
    remove.textContent = 'Unfollow';
    remove.addEventListener('click', async () => {
      await unsubscribe(channel.id);
      rerender();
    });

    row.append(main, remove);
    body.appendChild(row);
  }

  root.replaceChildren(header('subscriptions'), body, localOnlyNote());

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

  const body = document.createElement('div');
  body.className = 'lt-list';
  for (const playlist of playlists) body.appendChild(playlistRow(playlist, rerender));

  root.replaceChildren(header('playlists', [create]), body, localOnlyNote());
}

function playlistRow(playlist: Playlist, rerender: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lt-row';

  const main = document.createElement('div');
  main.className = 'lt-row-main';
  const title = document.createElement('a');
  title.className = 'lt-row-title';
  title.href = viewHash({ name: 'playlist', id: playlist.id });
  title.textContent = playlist.name;
  title.addEventListener('click', (event) => {
    event.preventDefault();
    go({ name: 'playlist', id: playlist.id });
  });
  const sub = document.createElement('div');
  sub.className = 'lt-row-sub';
  sub.textContent = `${playlist.videos.length} video${playlist.videos.length === 1 ? '' : 's'}`;
  main.append(title, sub);
  row.appendChild(main);

  // System playlists (Watch Later, Liked) cannot be renamed or deleted.
  if (!playlist.system) {
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'lt-btn';
    rename.textContent = 'Rename';
    rename.addEventListener('click', async () => {
      const name = prompt('Playlist name', playlist.name);
      if (name === null) return;
      await renamePlaylist(playlist.id, name);
      rerender();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lt-btn';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
      await deletePlaylist(playlist.id);
      rerender();
    });

    row.append(rename, remove);
  }
  return row;
}

/* ------------------------------------------------------- playlist detail */

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

  const title = document.createElement('h1');
  title.style.cssText = 'font:500 24px/1.3 Roboto,Arial,sans-serif;margin:0 0 4px';
  title.textContent = playlist.name;

  const meta = document.createElement('div');
  meta.className = 'lt-card-sub';
  meta.style.marginBottom = '20px';
  meta.textContent = `${playlist.videos.length} video${playlist.videos.length === 1 ? '' : 's'} · created ${timeAgo(new Date(playlist.createdAt).toISOString())}`;

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'lt-btn lt-btn-primary';
  play.textContent = 'Play all';
  play.disabled = playlist.videos.length === 0;
  play.addEventListener('click', () => {
    // The queue id travels in the hash so it survives navigation without
    // colliding with YouTube's own `list=` parameter.
    location.href = `/watch?v=${encodeURIComponent(playlist.videos[0].id)}#localtube-queue=${playlist.id}`;
  });

  const body =
    playlist.videos.length === 0
      ? emptyState('Nothing saved yet', 'Use the Save button under any video to add it here.')
      : videoGrid(playlist.videos, {
          label: 'Remove',
          title: 'Remove from this playlist',
          onClick: async (video: Video) => {
            await removeFromPlaylist(playlist.id, video.id);
            rerender();
          },
        });

  root.replaceChildren(header('playlist', [play]), title, meta, body, localOnlyNote());
}
