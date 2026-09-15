// Replaces every YouTube Subscribe button on the page, wherever it appears.
//
// Enumerating locations does not work: Subscribe shows up on the watch page, in
// search results, in channel shelves, on hover cards, and once per author on a
// collaboration — and YouTube keeps adding places. So this module does not know
// about locations at all. It looks for controls the MAIN world has tagged with
// their channel id (see src/mainworld/ytdata.ts) and replaces each one with a
// LocalTube button bound to *that row's* channel.
//
// That binding is the point: previously a single button was mounted per page
// using the watch page's primary channel, so on a collaboration every button
// followed the first author.

import { generation } from '@/content/youtube-dom';
import { writesAllowed } from '@/content/account';
import type { Subscription } from '@/types';
import { nativeSkinOn } from '@/content/native-skin';
import { flashToast } from '@/content/toast';
import { getData } from '@/lib/store';
import { resolveTitle, toggleSubscription } from '@/lib/subscriptions';

const CLASS = 'lt-follow-anywhere';

/** Where our button goes for a given tagged host. */
function mountPointFor(host: HTMLElement): HTMLElement | null {
  switch (host.tagName.toLowerCase()) {
    // The renderer itself is hidden, so we sit beside it and take its place.
    case 'ytd-subscribe-button-renderer':
      return host.parentElement;
    // These wrap the button in a strip that stays visible.
    case 'ytd-channel-renderer':
      return host.querySelector('#buttons');
    case 'ytd-grid-channel-renderer':
      return host.querySelector('#channel') ?? host.querySelector('#subscribe')?.parentElement ?? null;
    case 'ytd-channel-about-metadata-renderer':
      return host.querySelector('#subscribe-button')?.parentElement ?? null;
    default:
      return host.parentElement;
  }
}

/** One channel behind a subscribe control, as tagged by the MAIN world. */
interface ChannelRef {
  id: string;
  title?: string;
  avatar?: string;
}

const POPOVER_ID = 'localtube-channels-popover';

/** The channels a control covers — several on a collaboration. */
function channelsOf(host: HTMLElement): ChannelRef[] {
  const json = host.dataset.localtubeChannels;
  if (json) {
    try {
      const parsed = JSON.parse(json) as ChannelRef[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // fall through to the plain id list
    }
  }
  return (host.dataset.localtubeCid ?? '')
    .split(',')
    .filter(Boolean)
    .map((id) => ({ id }));
}

const nameOf = (c: ChannelRef, known?: Subscription): string => c.title || known?.title || c.id;

export function closeChannelsPopover(): void {
  document.getElementById(POPOVER_ID)?.remove();
}

/**
 * The per-channel list a collaboration's Subscribe opens.
 *
 * Mirrors what YouTube does with the same button: rather than one control that
 * silently follows several channels, show them and let each be followed on its
 * own. The channel names and avatars come from the dialog data YouTube attaches
 * to that very button.
 */
async function openChannelsPopover(button: HTMLElement, channels: ChannelRef[]): Promise<void> {
  closeChannelsPopover();

  const popover = document.createElement('div');
  popover.id = POPOVER_ID;
  popover.className = 'lt-popover';
  const rect = button.getBoundingClientRect();
  popover.style.top = `${rect.bottom + window.scrollY + 8}px`;
  popover.style.left = `${Math.max(8, rect.left + window.scrollX - 40)}px`;

  const render = async (): Promise<void> => {
    const { subscriptions } = await getData();
    popover.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'lt-popover-head';
    heading.textContent = `Follow ${channels.length} channels`;
    popover.appendChild(heading);

    for (const channel of channels) {
      const row = document.createElement('div');
      row.className = 'lt-popover-channel';

      if (channel.avatar) {
        const img = document.createElement('img');
        img.src = channel.avatar;
        img.alt = '';
        row.appendChild(img);
      }

      const name = document.createElement('span');
      name.className = 'lt-popover-name';
      name.textContent = nameOf(channel, subscriptions[channel.id]);
      row.appendChild(name);

      const following = Boolean(subscriptions[channel.id]);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lt-native lt-native-subscribe lt-accent';
      toggle.textContent = following ? 'Subscribed' : 'Subscribe';
      toggle.setAttribute('aria-pressed', String(following));
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          const now = await toggleSubscription({
            id: channel.id,
            title: nameOf(channel, subscriptions[channel.id]),
            avatar: channel.avatar,
          });
          if (now) await resolveTitle(channel.id);
          await render();
          void mountSubscribeEverywhere();
        } finally {
          toggle.disabled = false;
        }
      });
      row.appendChild(toggle);
      popover.appendChild(row);
    }
  };

  await render();
  document.body.appendChild(popover);

  window.setTimeout(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (popover.contains(event.target as Node) || button.contains(event.target as Node)) return;
      closeChannelsPopover();
      document.removeEventListener('click', onDocClick);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeChannelsPopover();
});

function paint(button: HTMLButtonElement, following: boolean, native: boolean): void {
  const label = native ? (following ? 'Subscribed' : 'Subscribe') : following ? 'Following' : 'Follow';
  if (button.textContent !== label) button.textContent = label;
  button.setAttribute('aria-pressed', String(following));
  button.title = following
    ? 'Following in LocalTube — stored in this browser, not on a Google account'
    : 'Follow in LocalTube — stored in this browser, not on a Google account';
}

export async function mountSubscribeEverywhere(): Promise<void> {
  // Follow is a write: signed in, YouTube's real Subscribe owns the page, and a
  // mid-session sign-in must take existing buttons down, not just stop new ones.
  if (!writesAllowed()) {
    for (const button of Array.from(document.querySelectorAll(`.${CLASS}`))) button.remove();
    closeChannelsPopover();
    return;
  }

  const hosts = Array.from(document.querySelectorAll<HTMLElement>('[data-localtube-cid]'));
  if (hosts.length === 0) return;

  const gen = generation();
  const native = nativeSkinOn();
  const { subscriptions } = await getData();
  if (gen !== generation()) return;

  for (const host of hosts) {
    const channels = channelsOf(host);
    if (channels.length === 0) continue;

    const mount = mountPointFor(host);
    if (!mount) continue;

    // One button per mount point, reused across re-renders.
    let button = mount.querySelector<HTMLButtonElement>(`:scope > .${CLASS}`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = `${CLASS} ${native ? 'lt-native lt-native-subscribe lt-accent' : 'lt-inject'}`;
      mount.appendChild(button);
    }
    button.dataset.ltCid = channels.map((c) => c.id).join(',');

    const followedCount = (map: Record<string, Subscription>): number =>
      channels.filter((c) => Boolean(map[c.id])).length;

    if (channels.length > 1) {
      // A collaboration: YouTube opens a list so each channel can be followed
      // on its own, and so does LocalTube. "Subscribed" only once all are.
      paint(button, followedCount(subscriptions) === channels.length, native);
      button.onclick = () => {
        if (document.getElementById(POPOVER_ID)) closeChannelsPopover();
        else void openChannelsPopover(button, channels);
      };
      continue;
    }

    const channel = channels[0];
    paint(button, Boolean(subscriptions[channel.id]), native);
    button.onclick = async () => {
      button.disabled = true;
      try {
        const following = await toggleSubscription({
          id: channel.id,
          title: nameOf(channel, subscriptions[channel.id]),
          avatar: channel.avatar,
        });
        paint(button, following, native);
        // The name may still be a placeholder; look it up before saying it.
        const resolved = following
          ? await Promise.race([
              resolveTitle(channel.id),
              new Promise<null>((r) => window.setTimeout(() => r(null), 2500)),
            ])
          : null;
        const name = resolved ?? nameOf(channel, subscriptions[channel.id]);
        flashToast(following ? `Following ${name} in LocalTube` : `Unfollowed ${name}`);
      } finally {
        button.disabled = false;
      }
    };
  }
}

/**
 * Re-run when a channel id is stamped onto a control.
 *
 * The MAIN world tags controls as YouTube renders them, which is usually after
 * this script's first pass — and always after it for a page opened directly.
 * Without this the watch page finds nothing to mount and never looks again.
 */
let watching = false;

export function watchForSubscribeHosts(): void {
  if (watching) return;
  watching = true;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      void mountSubscribeEverywhere().catch(() => undefined);
    }, 200);
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-localtube-cid'],
  });
}
