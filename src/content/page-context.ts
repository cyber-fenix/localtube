// Reads what the MAIN-world script (src/mainworld/ytdata.ts) publishes about the
// current page: channel id/title/avatar, and on a watch page the video too.
// The DOM fallback covers the moment before the bridge is populated.

export interface PageContext {
  videoId?: string;
  videoTitle?: string;
  published?: string;
  thumbnail?: string;
  /** Video length in seconds, from the player response rather than the
   *  <video> element — during a pre-roll the element reports the ad's. */
  duration?: number;
  channelId?: string;
  channelTitle?: string;
  avatar?: string;
  handle?: string;
  subscribers?: string;
}

function fromBridge(): PageContext | null {
  const raw = document.documentElement.dataset.localtubeChannel;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PageContext;
  } catch {
    return null;
  }
}

/** Channel pages carry the canonical `/channel/UC...` URL in a <link>, which is
 *  the one channel id YouTube still exposes in the DOM. */
function fromCanonical(): PageContext | null {
  const href = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';
  const id = /\/channel\/(UC[\w-]{22})/.exec(href)?.[1];
  if (!id) return null;
  return {
    channelId: id,
    channelTitle:
      document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? id,
  };
}

export function readContext(): PageContext | null {
  const bridged = fromBridge();
  if (bridged?.channelId) return bridged;
  return fromCanonical();
}

/**
 * Wait for the context that describes THIS video.
 *
 * The MAIN-world bridge only overwrites its attribute once it can build a
 * context for the current URL, so between an in-page navigation and that
 * moment the attribute still describes the PREVIOUS video. `waitForContext`
 * only asks for a channel id, so on a watch page it happily returns that stale
 * value — which is how a history entry ended up wearing the last video's
 * thumbnail. Anything keyed to a specific video must wait for its own id.
 */
export function waitForVideoContext(videoId: string, timeoutMs = 8000): Promise<PageContext | null> {
  const matches = (context: PageContext | null): boolean => context?.videoId === videoId;
  const immediate = readContext();
  if (matches(immediate)) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const context = readContext();
      if (matches(context)) {
        window.clearInterval(timer);
        resolve(context);
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 200);
  });
}

/**
 * Wait for the page context to name a channel. YouTube populates its data
 * objects after navigation completes, so the first read on a fresh watch page
 * usually finds nothing.
 */
export function waitForContext(timeoutMs = 8000): Promise<PageContext | null> {
  const immediate = readContext();
  if (immediate?.channelId) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const context = readContext();
      if (context?.channelId) {
        window.clearInterval(timer);
        resolve(context);
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 200);
  });
}
