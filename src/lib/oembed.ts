// YouTube's public oEmbed endpoint — the one place a channel's @handle can be
// had without opening a page.
//
// Why this exists: the Atom feed LocalTube builds its subscriptions from
// carries a channel id and a title, and nothing else. The handle and the
// subscriber count live in YouTube's page data, so until now a channel only
// gained them once you happened to visit it — and a list imported from a
// Takeout file never had.
//
// oEmbed answers half of that cheaply. It is a documented public standard, it
// needs no key and no login, its response is a few hundred bytes, and its
// `author_url` is the channel's handle URL. It carries no subscriber count and
// no duration; both of those are only in the ~1.2 MB watch page, which is why
// neither is fetched in bulk.

/** Sent without cookies, like every other request LocalTube makes. */
const OEMBED = 'https://www.youtube.com/oembed?format=json&url=';

export interface OembedResult {
  /** `@handle`, when the author URL is in handle form. */
  handle?: string;
  /** The channel's name as YouTube writes it. */
  title?: string;
}

/**
 * Ask about one video to learn about its channel.
 *
 * There is no oEmbed for a channel URL, so identifying a channel means naming
 * one of its videos — which the feed cache always has.
 */
export async function channelFromVideo(videoId: string): Promise<OembedResult | null> {
  const url = `${OEMBED}${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const data = (await response.json()) as { author_url?: string; author_name?: string };
    const handle = /\/(@[\w.-]+)$/.exec(data.author_url ?? '')?.[1];
    if (!handle && !data.author_name) return null;
    return { handle, title: data.author_name };
  } catch {
    // A deleted or private video, or simply offline. The caller treats a null
    // as "not now", never as "this channel has no handle".
    return null;
  }
}
