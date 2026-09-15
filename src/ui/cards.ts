// Shared video-card rendering, used by both the feed and the playlist views so
// the two never drift apart visually.

import type { Video } from '@/types';

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

  const href = `/watch?v=${encodeURIComponent(video.id)}`;

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

  body.append(avatar, meta);
  card.append(link, body);

  // Where YouTube's kebab sits: a 40x40 slot at the top right of the metadata.
  if (action) {
    const button = document.createElement('button');
    button.className = 'lt-card-action';
    button.type = 'button';
    button.textContent = action.label;
    button.title = action.title;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void action.onClick(video);
    });
    card.appendChild(button);
  }

  return card;
}

export function videoGrid(videos: Video[], action?: CardAction, options?: GridOptions): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'lt-grid';
  for (const video of videos) grid.appendChild(videoCard(video, action, options));
  return grid;
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
