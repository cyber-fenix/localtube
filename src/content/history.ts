// Records what you watch, in this browser only.
//
// Two decisions worth stating, because both are visible to the user:
//
//  - A video counts as watched after ten seconds of PLAYBACK, not ten seconds
//    on the page. Opening a video and immediately leaving does not fill the
//    list with things you never saw, and a paused tab left open all afternoon
//    records nothing.
//  - Nothing is recorded while the video id under the cursor keeps changing,
//    so clicking through a row of suggestions leaves one entry, not six.

import { anchor, currentRoute, currentVideoId } from '@/content/youtube-dom';
import { waitForVideoContext } from '@/content/page-context';
import { historyEnabled, recordWatch } from '@/lib/history';
import type { Video } from '@/types';

/** Seconds of playback before a video is considered watched. */
const WATCHED_AFTER = 10;
/** Give up watching for playback after this long; the tab may just be idle. */
const GIVE_UP_AFTER = 30 * 60 * 1000;

/** The video this page load is already tracking, so route() re-runs (a storage
 *  change, a theme change) do not start a second timer for it. */
let tracking: string | null = null;

/** Resolve once `videoId` has played long enough, or false if we left it. */
function playedEnough(videoId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (currentVideoId() !== videoId) {
        window.clearInterval(timer);
        resolve(false);
        return;
      }
      const player = anchor('video') as HTMLVideoElement | null;
      if (player && player.currentTime >= WATCHED_AFTER) {
        window.clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started > GIVE_UP_AFTER) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 1000);
  });
}

export async function mountHistory(): Promise<void> {
  if (currentRoute() !== 'watch') {
    tracking = null;
    return;
  }
  const videoId = currentVideoId();
  if (!videoId || tracking === videoId) return;
  tracking = videoId;

  if (!(await historyEnabled())) return;

  // The title and channel arrive with the page data, which lands after
  // navigation finishes — and we have ten seconds of playback to wait for
  // anyway, so there is no hurry.
  //
  // It must be the context for THIS video, not merely any context: until the
  // bridge catches up it still describes the previous one, which is how an
  // entry ended up with the last video's thumbnail and title.
  //
  // Deliberately NOT guarded on generation(): loading a watch page fires
  // yt-navigate-finish, so the generation ticks while we are still on the very
  // video we are tracking. Comparing the video id is the check that means what
  // it says here. Guarding on the generation recorded nothing at all.
  const context = await waitForVideoContext(videoId);
  if (currentVideoId() !== videoId) {
    tracking = null;
    return;
  }

  const video: Video = {
    id: videoId,
    title: context?.videoTitle ?? document.title.replace(/ - YouTube$/, ''),
    channelId: context?.channelId ?? '',
    channelTitle: context?.channelTitle ?? '',
    published: context?.published ?? '',
    // Falls back to the URL YouTube derives from the video id, which is right
    // by construction — never to whatever the bridge last published.
    thumbnail: context?.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };

  if (!(await playedEnough(videoId))) {
    tracking = null;
    return;
  }
  await recordWatch(video);
}
