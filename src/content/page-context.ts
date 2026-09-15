// Reads what the MAIN-world script (src/mainworld/ytdata.ts) publishes about the
// current page: channel id/title/avatar, and on a watch page the video too.
// The DOM fallback covers the moment before the bridge is populated.

export interface PageContext {
  videoId?: string;
  videoTitle?: string;
  published?: string;
  thumbnail?: string;
  channelId?: string;
  channelTitle?: string;
  avatar?: string;
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
