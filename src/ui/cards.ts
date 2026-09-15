// Shared video-card rendering, used by both the feed and the playlist views so
// the two never drift apart visually.

import { PATHS, icon } from '@/ui/icons';
import { openCardMenu, type MenuItem } from '@/ui/menu';
import { videoMenuItems } from '@/ui/video-menu';
import type { ProgressEntry, Video } from '@/types';
import { resumeAt, watchedFraction } from '@/lib/progress';

/** The kebab button, wired to the shared video menu. */
export function kebab(video: Video, extra: MenuItem[] = []): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lt-kebab';
  button.title = 'More actions';
  button.setAttribute('aria-label', 'More actions');
  button.appendChild(icon(PATHS.kebab));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCardMenu(button, videoMenuItems(video, button, extra));
  });
  return button;
}

/** `1:01:27` / `9:07`, YouTube's own phrasing: no leading zero on the first
 *  unit, two digits on everything after it. */
export function clockDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The duration badge, bottom right of a cover.
 *
 * Measured on a live search page: 20px tall at a 4px radius on
 * rgba(0,0,0,0.6), 1px/4px padding, 500 12px/18px white, inset 8px from the
 * cover's right and bottom edges.
 *
 * Only videos LocalTube has seen on a watch page have a duration at all — the
 * channel feed carries none — so unwatched cards simply have no badge rather
 * than a placeholder.
 */
export function durationBadge(seconds?: number): HTMLElement | null {
  const label = clockDuration(seconds ?? 0);
  if (!label) return null;
  const badge = document.createElement('div');
  badge.className = 'lt-duration';
  badge.textContent = label;
  return badge;
}

/**
 * The red watched bar across the bottom of a cover.
 *
 * Returns null rather than an empty bar for an unwatched video: YouTube shows
 * nothing at all there, and an always-present grey track would put a line under
 * every thumbnail in the feed.
 */
export function progressBar(fraction: number): HTMLElement | null {
  if (!(fraction > 0)) return null;
  const track = document.createElement('div');
  track.className = 'lt-progress';
  const fill = document.createElement('div');
  fill.className = 'lt-progress-fill';
  fill.style.width = `${Math.min(100, Math.round(fraction * 1000) / 10)}%`;
  track.appendChild(fill);
  return track;
}

/** Bind a progress map to a lookup the card builders can call per video. */
export function progressFor(
  progress: Record<string, ProgressEntry>,
): (videoId: string) => ProgressEntry | undefined {
  return (videoId) => progress[videoId];
}

/**
 * The watch URL for a video, carrying where you stopped.
 *
 * Resume rides in `&t=` rather than being seeked once the page is open, because
 * YouTube applies a start time AFTER any pre-roll. Seeking the <video> element
 * ourselves lands in the middle of the ad, and the real video then begins at
 * zero — which is exactly what it did before this.
 */
export function watchHref(videoId: string, entry?: ProgressEntry): string {
  const base = `/watch?v=${encodeURIComponent(videoId)}`;
  const at = resumeAt(entry);
  return at === null ? base : `${base}&t=${Math.floor(at)}s`;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function formatViews(views?: number): string {
  if (!views || views < 0) return '';
  if (views < 1000) return `${views} views`;
  if (views < 1_000_000) return `${Math.round(views / 100) / 10}K views`;
  if (views < 1_000_000_000) return `${Math.round(views / 100_000) / 10}M views`;
  return `${Math.round(views / 100_000_000) / 10}B views`;
}

export interface CardAction {
  label: string;
  title: string;
  onClick: (video: Video) => void | Promise<void>;
}

/**
 * Per-grid options. `note` replaces the card's publish date; `avatar` supplies
 * the channel avatar YouTube shows beside the title, which LocalTube can only
 * fill in for channels you follow.
 */
export interface GridOptions {
  note?: (video: Video) => string;
  avatar?: (video: Video) => string | undefined;
  /** Where you stopped, if anywhere. See progressFor(). */
  progress?: (videoId: string) => ProgressEntry | undefined;
}

/**
 * A home-feed card, measured on a live youtube.com (dark, 1496px, guide open):
 * a 16:9 cover at a 12px radius, 12px to the metadata, a 36px channel avatar
 * with 8px to the text, a 500 16px/22px title clamped to two lines with 24px of
 * room for the action, and 14px/20px metadata rows 2px apart.
 */
export function videoCard(video: Video, action?: CardAction, options?: GridOptions): HTMLElement {
  const card = document.createElement('div');
  card.className = 'lt-card';

  const watched = options?.progress?.(video.id);
  const href = watchHref(video.id, watched);

  const link = document.createElement('a');
  link.className = 'lt-card-link';
  link.href = href;

  const thumb = document.createElement('div');
  thumb.className = 'lt-thumb';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = video.thumbnail;
  img.alt = '';
  thumb.appendChild(img);
  // No length on a Short, the way YouTube shows none: a Short's length is not
  // information anyone is deciding on, and a badge there reads as a mistake.
  const badge = video.isShort ? null : durationBadge(video.duration ?? watched?.duration);
  if (badge) thumb.appendChild(badge);
  const bar = progressBar(watchedFraction(watched));
  if (bar) thumb.appendChild(bar);
  link.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'lt-card-body';

  // The avatar slot is kept even without an avatar, so titles line up down the
  // column whether or not we know the channel's picture.
  const avatar = document.createElement('div');
  avatar.className = 'lt-card-avatar';
  const avatarUrl = options?.avatar?.(video);
  if (avatarUrl) {
    const face = document.createElement('img');
    face.loading = 'lazy';
    face.alt = '';
    face.src = avatarUrl;
    face.addEventListener('error', () => face.remove(), { once: true });
    avatar.appendChild(face);
  } else if (video.channelTitle) {
    avatar.textContent = video.channelTitle.trim().charAt(0).toUpperCase();
    avatar.classList.add('lt-card-avatar-initial');
  }

  const meta = document.createElement('div');
  meta.className = 'lt-meta';

  const title = document.createElement('a');
  title.className = 'lt-card-title';
  title.href = href;
  title.textContent = video.title;
  title.title = video.title;
  meta.appendChild(title);

  if (video.channelTitle) {
    const channel = document.createElement('div');
    channel.className = 'lt-card-row';
    channel.textContent = video.channelTitle;
    meta.appendChild(channel);
  }

  const stats = [
    formatViews(video.views),
    options?.note ? options.note(video) : timeAgo(video.published),
  ].filter(Boolean);
  if (stats.length > 0) {
    const line = document.createElement('div');
    line.className = 'lt-card-row';
    line.textContent = stats.join(' • ');
    meta.appendChild(line);
  }

  // YouTube's kebab, in YouTube's slot: 40x40 at the top right of the metadata.
  // Anchored to the metadata row rather than the card, so its position does not
  // depend on the cover's height.
  const extra: MenuItem[] = action
    ? [{ label: action.label, path: PATHS.trash, onClick: () => void action.onClick(video) }]
    : [];
  body.append(avatar, meta, kebab(video, extra));
  card.append(link, body);

  return card;
}

export function videoGrid(videos: Video[], action?: CardAction, options?: GridOptions): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'lt-grid';
  for (const video of videos) grid.appendChild(videoCard(video, action, options));
  return grid;
}

/**
 * The Shorts shelf: one horizontal row of vertical covers.
 *
 * Shorts arrive in the same Atom feed as uploads, with nothing to tell them
 * apart, so before this they sat in the chronological grid wearing 16:9
 * thumbnails — which is what "the feed mixes Shorts in" meant. Shelving them
 * follows YouTube's own home page: they are a different kind of thing and they
 * do not belong in a reverse-chronological column of videos.
 *
 * The row scrolls horizontally rather than wrapping, so a burst of Shorts from
 * one channel cannot push the actual videos below the fold.
 */
export function shortsShelf(videos: Video[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'lt-shorts';

  const heading = document.createElement('h2');
  heading.className = 'lt-shorts-title';
  heading.textContent = 'Shorts';
  section.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'lt-shorts-row';

  for (const video of videos) {
    const card = document.createElement('div');
    card.className = 'lt-short';

    // A Short opens on its own player, not the watch page — the same URL
    // YouTube's own card points at. Resume does not apply: there is nowhere
    // to resume to in a sixty-second video.
    const link = document.createElement('a');
    link.className = 'lt-short-link';
    link.href = `/shorts/${encodeURIComponent(video.id)}`;

    const thumb = document.createElement('div');
    thumb.className = 'lt-short-thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    // A Short's cover is vertical; the feed only ever gave us the 16:9 frame,
    // so ask for the portrait one and fall back to what we have.
    img.src = `https://i.ytimg.com/vi/${video.id}/oardefault.jpg`;
    img.addEventListener('error', () => { img.src = video.thumbnail; }, { once: true });
    thumb.appendChild(img);
    link.appendChild(thumb);

    const title = document.createElement('a');
    title.className = 'lt-short-title';
    title.href = link.href;
    title.textContent = video.title;
    title.title = video.title;

    const meta = document.createElement('div');
    meta.className = 'lt-short-row';
    meta.textContent = [video.channelTitle, formatViews(video.views)].filter(Boolean).join(' • ');

    const menu = kebab(video);
    menu.classList.add('lt-short-kebab');

    card.append(link, title, meta, menu);
    row.appendChild(card);
  }

  section.appendChild(row);
  return section;
}

/** Empty / error state with an optional call to action. */
export function emptyState(
  heading: string,
  body: string,
  cta?: { label: string; onClick: () => void },
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lt-empty';

  const h = document.createElement('h2');
  h.textContent = heading;
  const p = document.createElement('p');
  p.textContent = body;
  wrap.append(h, p);

  if (cta) {
    const button = document.createElement('button');
    button.className = 'lt-btn lt-btn-primary';
    button.type = 'button';
    button.textContent = cta.label;
    button.addEventListener('click', cta.onClick);
    wrap.appendChild(button);
  }
  return wrap;
}
