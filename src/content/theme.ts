// Tells LocalTube's stylesheet which theme YouTube is in.
//
// The first version of the stylesheet read YouTube's own `--yt-spec-*` custom
// properties. They do not resolve where our injected controls live, so every
// declaration silently fell back to its literal — and the literals were all
// light-theme values, which is how the buttons ended up black-on-black for
// anyone using dark mode.
//
// So we decide the theme ourselves and stamp it on <html>, and the stylesheet
// keys off that alone. No dependency on YouTube's variable names.

const ATTR = 'localtubeTheme'; // -> data-localtube-theme

/** True when a CSS colour string is dark enough to need light text on it. */
function isDark(color: string): boolean {
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) return false;
  const [r, g, b] = parts.map(Number);
  // Fully transparent tells us nothing about what is painted underneath.
  if (parts.length >= 4 && Number(parts[3]) === 0) return false;
  // Rec. 601 luma, the usual quick brightness test.
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

function detect(): 'dark' | 'light' {
  // YouTube's own signal, present as soon as the page paints.
  if (document.documentElement.hasAttribute('dark')) return 'dark';
  // Fallback: read what the page is actually painted. Survives YouTube
  // dropping or renaming the `dark` attribute.
  const body = document.body && getComputedStyle(document.body).backgroundColor;
  if (body && isDark(body)) return 'dark';
  return 'light';
}

export function syncTheme(): void {
  const theme = detect();
  if (document.documentElement.dataset[ATTR] !== theme)
    document.documentElement.dataset[ATTR] = theme;
}

/** Keep in step when the user switches theme without reloading. */
export function watchTheme(): void {
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['dark'],
  });
}
