// LocalTube's follow control, injected next to (or in place of) YouTube's own
// Subscribe on watch and channel pages.
//
// With the native skin on it wears YouTube's pill styling and says
// "Subscribe" / "Subscribed", because YouTube's own button is hidden and this
// one stands in for it. The red leading edge marks it as LocalTube's, and the
// tooltip stays honest: the list is local to this browser and touches no Google
// account.

import { anchor, currentRoute, generation, waitForAnchor } from '@/content/youtube-dom';
import { writesAllowed } from '@/content/account';
import { nativeSkinOn } from '@/content/native-skin';
import { readContext, waitForContext } from '@/content/page-context';
import { singleFlight } from '@/content/single-flight';
import { flashToast } from '@/content/toast';
import { isSubscribed, noteChannelDetails, toggleSubscription } from '@/lib/subscriptions';

const BUTTON_ID = 'localtube-follow';

function paint(button: HTMLButtonElement, following: boolean, native: boolean): void {
  const label = native
    ? following
      ? 'Subscribed'
      : 'Subscribe'
    : following
      ? 'Following'
      : 'Follow';
  if (button.textContent !== label) button.textContent = label;
  button.setAttribute('aria-pressed', String(following));
  button.title = following
    ? 'Following in LocalTube — stored in this browser, not on a Google account'
    : 'Follow in LocalTube — stored in this browser, not on a Google account';
}

/**
 * The channel page header only.
 *
 * Everywhere else — the watch page, search results, shelves, hover cards, the
 * extra authors on a collaboration — is handled by
 * content/subscribe-anywhere.ts, which binds each button to its own channel.
 * The header is the exception because it carries no
 * `ytd-subscribe-button-renderer` for the MAIN world to tag: its Subscribe is a
 * bare button-view-model inside yt-flexible-actions-view-model, so the channel
 * id has to come from the page context instead.
 */
/** Single-flighted for the same reason as the watch-page actions: two callers
 *  inside one mount each build their own button. */
export const mountSubscribeButton = singleFlight(mountSubscribeButtonOnce);

async function mountSubscribeButtonOnce(): Promise<void> {
  // Follow is a write: signed in, YouTube's real Subscribe owns the header, and
  // a mid-session sign-in must take this button down, not just stop new mounts.
  if (currentRoute() !== 'channel' || !writesAllowed()) {
    document.getElementById(BUTTON_ID)?.remove();
    return;
  }

  // YouTube renders the channel header after document_idle, so the anchor is
  // usually absent on the first pass. Wait for it rather than giving up.
  const gen = generation();
  const host = anchor('channelHeader') ?? (await waitForAnchor('channelHeader'));
  if (!host || gen !== generation()) return;

  const context = (await waitForContext()) ?? readContext();
  // The wait may have outlived the page it started on.
  if (!context?.channelId || gen !== generation()) return;

  const native = nativeSkinOn();
  const existing = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  const button = existing ?? document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.className = native ? 'lt-native lt-native-subscribe lt-accent' : 'lt-inject';

  const channel = {
    id: context.channelId,
    title: context.channelTitle ?? context.channelId,
    avatar: context.avatar,
    handle: context.handle,
    subscribers: context.subscribers,
  };

  // Visiting a channel you already follow is the chance to learn its @handle
  // and subscriber count — neither of which the feed carries, and neither of
  // which a Takeout import brings with it.
  void noteChannelDetails(channel).catch(() => undefined);

  paint(button, await isSubscribed(channel.id), native);
  button.onclick = async () => {
    button.disabled = true;
    try {
      const following = await toggleSubscription(channel);
      paint(button, following, native);
      flashToast(
        following ? `Following ${channel.title} in LocalTube` : `Unfollowed ${channel.title}`,
      );
    } finally {
      button.disabled = false;
    }
  };

  if (button.parentElement !== host) host.appendChild(button);
}
