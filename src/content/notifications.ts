// LocalTube's bell in YouTube's masthead.
//
// YouTube renders a bell even when signed out — it opens an empty
// "Your notifications live here" panel and nothing else, which is verified,
// not assumed (checked live 2026-09-11: the panel opens, and carries no
// sign-in link). The native skin hides that one and LocalTube puts its own in
// the same slot, filled from the feed LocalTube already refreshes.
//
// The honest limit, stated in the popup and in the panel's own empty state:
// this fills while you are on YouTube. There is no background worker and no
// `notifications` permission, so nothing checks for uploads while the browser
// is elsewhere — which is the trade that keeps the permission list at
// `storage` plus the YouTube host.

import { anchor, generation, waitForAnchor } from '@/content/youtube-dom';
import { nativeSkinOn } from '@/content/native-skin';
import { singleFlight } from '@/content/single-flight';
import { AVATAR_ID } from '@/content/masthead';
import { clearNotifications, listNotifications, markAllRead } from '@/lib/notifications';
import { getData, setSettings } from '@/lib/store';
import { timeAgo } from '@/ui/cards';
import { PATHS, icon } from '@/ui/icons';
import type { NotificationEntry } from '@/types';

export const BELL_ID = 'localtube-bell';
const PANEL_ID = 'localtube-notifications';
const MENU_ID = 'localtube-notifications-menu';

export function closeNotifications(): void {
  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(MENU_ID)?.remove();
}

/** One row: who uploaded what, and when. */
function notificationRow(entry: NotificationEntry): HTMLElement {
  const row = document.createElement('a');
  row.className = 'lt-notif';
  if (!entry.read) row.classList.add('lt-notif-unread');
  row.href = `/watch?v=${encodeURIComponent(entry.videoId)}`;

  const dot = document.createElement('span');
  dot.className = 'lt-notif-dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('div');
  text.className = 'lt-notif-text';
  const line = document.createElement('div');
  line.className = 'lt-notif-line';
  line.textContent = `${entry.channelTitle} uploaded: ${entry.title}`;
  const when = document.createElement('div');
  when.className = 'lt-notif-when';
  when.textContent = timeAgo(entry.published);
  text.append(line, when);

  const thumb = document.createElement('img');
  thumb.className = 'lt-notif-thumb';
  thumb.loading = 'lazy';
  thumb.alt = '';
  thumb.src = entry.thumbnail;
  thumb.addEventListener('error', () => thumb.remove(), { once: true });

  row.append(dot, text, thumb);
  return row;
}

function emptyPanel(): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'lt-notif-empty';

  const bell = icon(PATHS.bell);
  bell.classList.add('lt-notif-empty-icon');

  const head = document.createElement('div');
  head.className = 'lt-notif-empty-head';
  head.textContent = 'Your notifications live here';

  const body = document.createElement('div');
  body.className = 'lt-notif-empty-body';
  // Says what it does AND what it cannot do. LocalTube checks for uploads
  // while you are on YouTube; claiming otherwise would be the one thing this
  // extension must never do.
  body.textContent =
    'New videos from channels you follow in LocalTube show up here. LocalTube checks while you have YouTube open.';

  empty.append(bell, head, body);
  return empty;
}

/** The gear's menu: the two things anyone actually wants from this panel. */
function openSettingsMenu(gear: HTMLElement, refresh: () => void): void {
  document.getElementById(MENU_ID)?.remove();

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'lt-popover';
  const rect = gear.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 8}px`;
  menu.style.left = `${Math.max(8, rect.right + window.scrollX - 240)}px`;

  const add = (label: string, onClick: () => void): void => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lt-popover-item';
    item.textContent = label;
    item.addEventListener('click', async () => {
      menu.remove();
      await onClick();
      refresh();
    });
    menu.appendChild(item);
  };

  add('Turn off upload notifications', async () => {
    await setSettings({ notifyUploads: false });
    closeNotifications();
  });
  add('Clear all', () => clearNotifications());

  document.body.appendChild(menu);
  window.setTimeout(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (menu.contains(event.target as Node) || gear.contains(event.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', onDocClick);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

/**
 * The panel, measured against YouTube's own (live, 2026-09-11): 480 wide at a
 * 12px radius on a `0 4px 32px rgba(0,0,0,.1)` shadow, docked at the
 * masthead's 56px bottom edge and right-aligned to the bell, with a 49px
 * header carrying a 16px/22px title 16px in, over a 1px 20% rule. The empty
 * state's bell is the same path at 120px.
 *
 * The ROW metrics are LocalTube's own: YouTube's signed-out panel is empty, so
 * there was nothing to measure, and inventing numbers to match a screenshot is
 * how a layout ends up subtly wrong everywhere.
 */
async function buildPanel(bell: HTMLElement): Promise<void> {
  closeNotifications();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'LocalTube notifications');

  const rect = bell.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 8}px`;
  // Right-aligned to the bell, exactly as YouTube's is, and clamped so a
  // narrow window cannot push it off-screen.
  panel.style.left = `${Math.max(8, Math.min(rect.right - 480, window.innerWidth - 488))}px`;

  const header = document.createElement('div');
  header.className = 'lt-notif-head';
  const title = document.createElement('div');
  title.className = 'lt-notif-title';
  title.textContent = 'Notifications';
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'lt-notif-gear';
  gear.title = 'Notification settings';
  gear.setAttribute('aria-label', 'Notification settings');
  gear.appendChild(icon(PATHS.gear));
  gear.addEventListener('click', (event) => {
    event.stopPropagation();
    openSettingsMenu(gear, () => void mountBell());
  });
  header.append(title, gear);

  const list = document.createElement('div');
  list.className = 'lt-notif-list';

  const entries = await listNotifications();
  if (entries.length === 0) list.appendChild(emptyPanel());
  else for (const entry of entries) list.appendChild(notificationRow(entry));

  panel.append(header, list);
  document.body.appendChild(panel);

  // Opening is what clears the badge — the rows stay where they are, because
  // the panel is a list of what arrived, not an inbox to process.
  await markAllRead();

  window.setTimeout(() => {
    const onDocClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panel.contains(target) || bell.contains(target)) return;
      if (document.getElementById(MENU_ID)?.contains(target)) return;
      closeNotifications();
      document.removeEventListener('click', onDocClick);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNotifications();
});

/** Paint the unread count onto an existing bell, without rebuilding it. */
function paintBadge(bell: HTMLElement, unread: number): void {
  let badge = bell.querySelector<HTMLElement>('.lt-bell-badge');
  if (unread === 0) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'lt-bell-badge';
    bell.appendChild(badge);
  }
  const label = unread > 9 ? '9+' : String(unread);
  if (badge.textContent !== label) badge.textContent = label;
}

/** Single-flighted for the same reason every other mount is: the id check
 *  happens before the awaits, so two callers would both insert a bell. */
export const mountBell = singleFlight(mountBellOnce);

async function mountBellOnce(): Promise<void> {
  const { settings, notifications } = await getData();
  const wanted = nativeSkinOn() && settings.notifyUploads;

  const existing = document.getElementById(BELL_ID);
  if (!wanted) {
    existing?.remove();
    closeNotifications();
    return;
  }

  const unread = notifications.filter((entry) => !entry.read).length;
  if (existing) {
    // Already there: repaint the count in place. Rebuilding would close the
    // panel under the user on every storage write.
    paintBadge(existing, unread);
    return;
  }

  const gen = generation();
  const host = anchor('masthead') ?? (await waitForAnchor('masthead'));
  if (!host || gen !== generation() || document.getElementById(BELL_ID)) return;

  const bell = document.createElement('button');
  bell.id = BELL_ID;
  bell.type = 'button';
  bell.title = 'LocalTube notifications — new videos from channels you follow here';
  bell.setAttribute('aria-label', 'LocalTube notifications');
  bell.appendChild(icon(PATHS.bell));
  paintBadge(bell, unread);
  bell.addEventListener('click', () => {
    if (document.getElementById(PANEL_ID)) closeNotifications();
    else void buildPanel(bell);
  });

  // Before LocalTube's avatar, so the masthead reads bell-then-profile the
  // way YouTube's does.
  const avatar = document.getElementById(AVATAR_ID);
  if (avatar && avatar.parentElement === host) host.insertBefore(bell, avatar);
  else host.appendChild(bell);
}
