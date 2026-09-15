// A shuffled play order for one playlist, for as long as this tab lives.
//
// sessionStorage rather than chrome.storage: a shuffle is a property of the
// session you are listening in, not of the account. Closing the tab forgets it,
// and it never reaches a backup.

const KEY = (playlistId: string): string => `localtube-shuffle:${playlistId}`;

/** The shuffled order for a playlist, or null when it is playing in order. */
export function readShuffle(playlistId: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(KEY(playlistId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? parsed : null;
  } catch {
    // Private windows and blocked site data both throw on access.
    return null;
  }
}

export function writeShuffle(playlistId: string, videoIds: string[]): void {
  try {
    sessionStorage.setItem(KEY(playlistId), JSON.stringify(videoIds));
  } catch {
    // Playing in order is a fine fallback; never let this break the click.
  }
}

export function clearShuffle(playlistId: string): void {
  try {
    sessionStorage.removeItem(KEY(playlistId));
  } catch {
    /* ignore */
  }
}

/** Fisher-Yates, so every order is equally likely. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
