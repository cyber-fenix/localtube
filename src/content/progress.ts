// Resume playback: remember where you stopped, and pick the video back up
// there next time.
//
// Three rules this follows, each of them a decision the user can feel:
//
//  - The URL always wins. A link with `t=` (or a chapter link, or a share at a
//    timestamp) is someone asking for a specific moment; resuming over it would
//    break the one thing the link was for.
//  - Resuming is silent but reversible. It seeks and says so, with "Play from
//    start" right there — rather than asking a question before every video.
//  - Nothing is recorded for a live stream. Its duration is 0 or Infinity, so a
//    "position" in it means nothing.
//
// And one rule learned the hard way: NOTHING here may read the player while an
// ad is playing. During a pre-roll the <video> element reports the ad's own
// currentTime and duration, so recording stored an ad position against the real
// video, the progress bar showed a few seconds against a ten-minute duration,
// and resuming seeked into the ad — after which the real video began at zero.

import { adShowing, anchor, currentRoute, currentVideoId, waitForAnchor } from '@/content/youtube-dom';
import { writesAllowed } from '@/content/account';
import { actionToast } from '@/content/toast';
import {
  MIN_RESUME_SECONDS,
  clearProgress,
  getProgress,
  resumeAt,
  resumeEnabled,
  saveProgress,
} from '@/lib/progress';
import { ContextInvalidated } from '@/lib/store';

/**
 * How often a position is written while playing.
 *
 * Also the worst case for what a navigation loses: YouTube swaps the URL before
 * we are told about it, so by the time we know you left, the player is already
 * reporting the NEXT video's time and the old position can no longer be read.
 * Five seconds of granularity is the price of never writing a wrong one.
 */
const WRITE_EVERY = 5000;

/** The video currently being tracked, and the element playing it. */
let tracked: { id: string; video: HTMLVideoElement } | null = null;
/** The video id whose setup has already run, so route() re-runs are no-ops. */
let arming: string | null = null;
let lastWrite = 0;

function ignore(error: unknown): void {
  // A dead extension context is expected once the extension is reloaded under
  // an open tab; content/index.ts handles the teardown.
  if (!(error instanceof ContextInvalidated)) console.error('[LocalTube]', error);
}

/** Write the current position, at most once per WRITE_EVERY unless forced. */
function flush(force = false): void {
  const current = tracked;
  if (!current) return;
  // Recording progress is a write. This is checked at the write (not only at
  // mount) because visibilitychange/pagehide can fire after the account flips,
  // and a flush then would be the one write that ignores the check.
  if (!writesAllowed()) return;
  // The player is showing an ad: its clock is not this video's.
  if (adShowing()) return;
  // The element outlives the page: if the URL has already moved on, its
  // currentTime belongs to the next video, not the one we are tracking.
  if (currentVideoId() !== current.id) return;

  const now = Date.now();
  if (!force && now - lastWrite < WRITE_EVERY) return;
  lastWrite = now;
  void saveProgress(current.id, current.video.currentTime, current.video.duration).catch(ignore);
}

/** Reaching the end clears the resume point by filling it: a finished video
 *  shows a full bar and never resumes into its own outro. */
function finish(): void {
  const current = tracked;
  if (!current || currentVideoId() !== current.id) return;
  // An ad fires `ended` too, and marking the video finished from it would both
  // lie on the card and stop the video ever resuming.
  if (adShowing()) return;
  lastWrite = Date.now();
  void saveProgress(current.id, current.video.duration, current.video.duration).catch(ignore);
}

/** Bind to the player once. YouTube reuses the same <video> across in-page
 *  navigation, so these listeners are attached to the element, not the page,
 *  and read whichever video `tracked` currently names. */
function attach(video: HTMLVideoElement): void {
  if (video.dataset.localtubeProgress) return;
  video.dataset.localtubeProgress = '1';
  video.addEventListener('timeupdate', () => flush());
  video.addEventListener('pause', () => flush(true));
  video.addEventListener('ended', finish);
}

function ready(video: HTMLVideoElement, timeoutMs = 10_000): Promise<boolean> {
  if (video.readyState >= 1) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean) => () => {
      video.removeEventListener('loadedmetadata', ok);
      window.clearTimeout(timer);
      resolve(value);
    };
    const ok = done(true);
    const timer = window.setTimeout(done(false), timeoutMs);
    video.addEventListener('loadedmetadata', ok, { once: true });
  });
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const [h, m, s] = parts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** True when the URL itself asks for a moment — `t=` / `start=`, which is what
 *  a shared timestamp and a chapter link both use. */
/** The seconds a `t=` / `start=` parameter asks for: `90`, `90s`, `1h2m3s`. */
export function urlSeconds(): number | null {
  const raw =
    new URLSearchParams(location.search).get('t') ??
    new URLSearchParams(location.search).get('start') ??
    /[#&](?:t|start)=([^&]+)/.exec(location.hash)?.[1] ??
    null;
  if (raw === null) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
  if (!parts) return null;
  const [, h, m, sec] = parts;
  const total = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0);
  return total > 0 ? total : null;
}

function urlNamesATime(): boolean {
  const query = new URLSearchParams(location.search);
  if (query.has('t') || query.has('start')) return true;
  return /[#&](t|start)=/.test(location.hash);
}

/** Resolve once no ad is playing, or false if we gave up / left the video. */
function adFinished(videoId: string, timeoutMs = 5 * 60_000): Promise<boolean> {
  if (!adShowing()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (currentVideoId() !== videoId) {
        window.clearInterval(timer);
        resolve(false);
      } else if (!adShowing()) {
        window.clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 500);
  });
}

/** Offer to undo a resume, whoever performed it. */
function offerUndo(videoId: string, video: HTMLVideoElement, at: number): void {
  actionToast(`Resumed at ${clock(at)}`, 'Play from start', () => {
    video.currentTime = 0;
    void clearProgress(videoId).catch(ignore);
  });
}

async function restore(videoId: string, video: HTMLVideoElement): Promise<void> {
  const at = resumeAt(await getProgress(videoId));

  if (urlNamesATime()) {
    // LocalTube's own links carry &t=, so YouTube does the seeking. That is
    // what makes resume ad-proof: YouTube applies the start time after the ad,
    // where seeking the element ourselves would land in the middle of the ad.
    // We still owe the user the undo, when the time in the URL is ours.
    const asked = urlSeconds();
    if (at !== null && asked !== null && Math.abs(asked - at) <= 2) {
      if (await adFinished(videoId)) offerUndo(videoId, video, at);
    }
    return;
  }

  if (at === null || currentVideoId() !== videoId) return;
  // Arriving from somewhere that is not a LocalTube link — a typed URL, a
  // YouTube recommendation. Seek ourselves, but never during an ad.
  if (!(await adFinished(videoId)) || currentVideoId() !== videoId) return;
  if (!(await ready(video)) || currentVideoId() !== videoId) return;
  // Metadata can take a while on a slow connection; by then you may already be
  // watching somewhere else in the video, and yanking you back would be worse
  // than not resuming at all.
  if (video.currentTime > MIN_RESUME_SECONDS) return;

  video.currentTime = at;
  offerUndo(videoId, video, at);
}

export async function mountProgress(): Promise<void> {
  // Recording a position is a write, and restoring one fights YouTube's own
  // signed-in resume. Signed in, both stand down.
  if (currentRoute() !== 'watch' || !writesAllowed()) {
    tracked = null;
    arming = null;
    return;
  }

  const videoId = currentVideoId();
  if (!videoId || arming === videoId) return;
  // Claimed before the first await, so two callers in one mount cannot both
  // set up the same video.
  arming = videoId;

  if (!(await resumeEnabled())) {
    tracked = null;
    return;
  }

  const video = (anchor('video') ?? (await waitForAnchor('video'))) as HTMLVideoElement | null;
  if (!video || currentVideoId() !== videoId) {
    arming = null;
    return;
  }

  tracked = { id: videoId, video };
  lastWrite = 0;
  attach(video);
  await restore(videoId, video);
}

// Leaving the tab, or the page, is the last chance to write. Registered once,
// at module scope, so navigations cannot pile up duplicates.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flush(true);
});
window.addEventListener('pagehide', () => flush(true));
