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

export function videoCard(video: Video, action?: CardAction): HTMLElement {
  const card = document.createElement('div');
  card.className = 'lt-card';

  const link = document.createElement('a');
  link.className = 'lt-card-link';
  link.href = `/watch?v=${encodeURIComponent(video.id)}`;

  const thumb = document.createElement('div');
  thumb.className = 'lt-thumb';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = video.thumbnail;
  img.alt = '';
  thumb.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'lt-meta';

  const title = document.createElement('div');
  title.className = 'lt-card-title';
  title.textContent = video.title;
  title.title = video.title;

  const sub = document.createElement('div');
  sub.className = 'lt-card-sub';
  sub.textContent = [video.channelTitle, formatViews(video.views), timeAgo(video.published)]
    .filter(Boolean)
    .join(' · ');

  meta.append(title, sub);
  link.append(thumb, meta);
  card.appendChild(link);

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

export function videoGrid(videos: Video[], action?: CardAction): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'lt-grid';
  for (const video of videos) grid.appendChild(videoCard(video, action));
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
