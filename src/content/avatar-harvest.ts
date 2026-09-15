// Drains the card-channel harvest the MAIN-world bridge publishes.
//
// Every video card YouTube renders carries its channel's id, avatar and
// handle in the card's own data; ytdata.ts reads them in the MAIN world and
// republishes them on a <html> attribute whenever it finds new ones. Reading
// them back costs no request at all — the data was already in the page — so
// this is how a Takeout import's channels get their pictures just from you
// browsing. lib/subscriptions.ts keeps only channels you already follow, and
// only writes when there is something new to keep.
//
// The attribute is a queue: the MAIN world fills it, this side reads and
// deletes it. Entries seen while the drain is in flight are republished when
// the MAIN world finds new channels, since it keeps the whole map until
// then — a lost drain costs a duplicate at worst, never a channel.

import { noteHarvestedChannels } from '@/lib/subscriptions';

const ATTR = 'data-localtube-card-channels';

function drain(): void {
  const root = document.documentElement;
  const raw = root.getAttribute(ATTR);
  if (!raw) return;
  root.removeAttribute(ATTR);
  try {
    const cards: unknown = JSON.parse(raw);
    if (!Array.isArray(cards) || cards.length === 0) return;
    const channels = cards
      .filter(
        (card): card is { id: string; a?: string; h?: string } =>
          Boolean(
            card && typeof card === 'object' && typeof (card as { id?: unknown }).id === 'string',
          ),
      )
      .map((card) => ({ id: card.id, avatar: card.a, handle: card.h }));
    if (channels.length > 0) void noteHarvestedChannels(channels).catch(() => undefined);
  } catch {
    // A truncated or foreign attribute is not ours to keep; it was already
    // deleted above, and the MAIN world will republish anything still fresh.
  }
}

/**
 * Watch the attribute for as long as the content script lives. The MAIN
 * world publishes on its own mutation loop; an attribute filter keeps this
 * cheap — no subtree observation.
 */
export function watchCardChannelHarvest(): void {
  drain();
  new MutationObserver(drain).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTR],
  });
}
