// Playlist playback. There is no custom player and no iframe embed — an embed
// fails on any video whose uploader disabled embedding. Instead the queue is
// navigation-based: we play videos on YouTube's own watch page and move to the
// next one when the current video ends.
//
// The playlist id rides in the URL hash (`#localtube-queue=<id>`) rather than a
// query parameter, so it never collides with YouTube's own `list=`.

import { anchor, currentRoute, currentVideoId, generation, waitForAnchor } from '@/content/youtube-dom';
import { getPlaylist } from '@/lib/playlists';
import type { Playlist } from '@/types';

const BAR_ID = 'localtube-queue';

const queueIdFromHash = (): string | null =>
  /#localtube-queue=([^&]+)/.exec(location.hash)?.[1] ?? null;

export const watchUrl = (videoId: string, queueId?: string): string =>
  `/watch?v=${encodeURIComponent(videoId)}${queueId ? `#localtube-queue=${queueId}` : ''}`;

function removeBar(): void {
  document.getElementById(BAR_ID)?.remove();
}

/** Attach the auto-advance listener once per <video> element per video id. */
function armAutoAdvance(playlist: Playlist, nextId: string | undefined): void {
  const video = anchor('video') as HTMLVideoElement | null;
  if (!video || !nextId) return;
  const key = `${playlist.id}:${nextId}`;
  if (video.dataset.localtubeQueue === key) return;
  video.dataset.localtubeQueue = key;
  video.addEventListener(
    'ended',
    () => {
      // Only advance if the queue is still the one we armed for.
      if (queueIdFromHash() === playlist.id) location.href = watchUrl(nextId, playlist.id);
    },
    { once: true },
  );
}

export async function mountQueue(): Promise<void> {
  const queueId = queueIdFromHash();
  const videoId = currentVideoId();
  if (currentRoute() !== 'watch' || !queueId || !videoId) {
    removeBar();
    return;
  }

  const playlist = await getPlaylist(queueId);
  if (!playlist) {
    removeBar();
    return;
  }

  const index = playlist.videos.findIndex((v) => v.id === videoId);
  const next = index >= 0 ? playlist.videos[index + 1] : undefined;
  armAutoAdvance(playlist, next?.id);

  const gen = generation();
  const host = anchor('watchOwner') ?? (await waitForAnchor('watchOwner'));
  if (!host?.parentElement || gen !== generation()) return;

  const bar = document.getElementById(BAR_ID) ?? document.createElement('div');
  bar.id = BAR_ID;
  bar.replaceChildren();

  const label = document.createElement('span');
  const position = index >= 0 ? `${index + 1} of ${playlist.videos.length}` : 'not in this playlist';
  label.append(
    document.createTextNode('Playing from '),
    Object.assign(document.createElement('strong'), { textContent: playlist.name }),
    document.createTextNode(` · ${position}`),
  );
  bar.appendChild(label);

  if (next) {
    const nextLink = document.createElement('a');
    nextLink.href = watchUrl(next.id, playlist.id);
    nextLink.textContent = `Next: ${next.title}`;
    nextLink.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    bar.appendChild(nextLink);
  } else {
    const done = document.createElement('span');
    done.style.flex = '1';
    done.textContent = 'End of playlist';
    bar.appendChild(done);
  }

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'lt-btn';
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname + location.search);
    removeBar();
  });
  bar.appendChild(stop);

  if (bar.parentElement !== host.parentElement) host.parentElement.insertBefore(bar, host);
}
