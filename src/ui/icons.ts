// Icons for the native-skin controls, drawn with DOM APIs rather than innerHTML.
// Content scripts run in an isolated world and are exempt from the page's CSP,
// but building nodes directly avoids depending on that and keeps the markup
// impossible to get wrong.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Material-style paths on a 24x24 grid, matching YouTube's own icon weight.
 *  Like and dislike come in a pair: outline when off, solid when on. */
export const PATHS = {
  thumbUpOutline:
    'M18.77 11h-4.23l1.52-4.94C16.38 5.03 15.54 4 14.38 4c-.58 0-1.14.24-1.52.65L7 11H3v10h4h1h9.43c1.06 0 1.98-.67 2.19-1.61l1.34-6C21.23 12.15 20.18 11 18.77 11zM7 20H4v-8h3v8zm12.98-6.83l-1.34 6c-.1.45-.61.83-1.21.83H8v-8.61l5.6-6.06c.19-.21.48-.33.78-.33.26 0 .5.11.63.3.07.1.15.26.09.47l-1.52 4.94-.4 1.29h1.35 4.23c.41 0 .8.17 1.03.46.12.15.25.4.19.71z',
  thumbUpSolid:
    'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
  thumbDownOutline:
    'M5.23 13h4.23l-1.52 4.94C7.62 18.97 8.46 20 9.62 20c.58 0 1.14-.24 1.52-.65L17 13h4V3h-4h-1H6.57c-1.06 0-1.98.67-2.19 1.61l-1.34 6C2.77 11.85 3.82 13 5.23 13zM17 4h3v8h-3V4zM4.02 10.83l1.34-6C5.46 4.35 5.97 4 6.57 4H16v8.61l-5.6 6.06c-.19.21-.48.33-.78.33-.26 0-.5-.11-.63-.3-.07-.1-.15-.26-.09-.47l1.52-4.94.4-1.29H9.46 5.23c-.41 0-.8-.17-1.03-.46-.12-.15-.25-.4-.19-.71z',
  thumbDownSolid:
    'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z',
  save: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19-2v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4z',
  play: 'M8 5v14l11-7z',
  // The three used by the History rail, in YouTube's own drawing.
  search:
    'M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z',
  trash: 'M11 17H9V8h2v9Zm4-9h-2v9h2V8Zm4-4v1h-1v16H6V5H5V4h4V3h6v1h4Zm-2 1H7v15h10V5Z',
  pause: 'M6 4h3.5v16H6V4Zm8.5 0H18v16h-3.5V4Z',
  // The card menu's three items.
  watchLater:
    'M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 110 18.001A9 9 0 0112 3Zm0 3a1 1 0 00-1 1v5.565l.485.292 3.33 2a1 1 0 001.03-1.714L13 11.435V7a1 1 0 00-1-1Z',
  bookmark: 'M18 2H6v20l6-4.5 6 4.5V2Zm-2 2v14l-4-3-4 3V4h8Z',
  share:
    'M15.03 3.53a.75.75 0 011.28.53V8.8h.19c3.6 0 6.5 2.92 6.5 6.5v3.95a.75.75 0 01-1.36.43l-.5-.7a9.2 9.2 0 00-7.02-3.83l.19 4.35a.75.75 0 01-1.28.56L4.6 12.53a.75.75 0 010-1.06l10.43-7.94Zm.28 2.24L6.2 12l9.11 6.23-.16-3.6a.75.75 0 01.75-.78h.6a10.7 10.7 0 017.19 2.77v-1.32a5 5 0 00-5-5h-.94a.75.75 0 01-.75-.75V5.77Z',
  kebab: 'M12 4a2 2 0 100 4 2 2 0 000-4Zm0 6a2 2 0 100 4 2 2 0 000-4Zm0 6a2 2 0 100 4 2 2 0 000-4Z',
  shuffle:
    'M17 4v2h2.586l-4.043 4.043 1.414 1.414L21 7.414V10h2V4h-6ZM3 6h4.586l3.457 3.457 1.414-1.414L8.414 4H3v2Zm14.543 7.543-1.414 1.414L19.586 18H17v2h6v-6h-2v2.586l-3.457-3.043ZM4.707 19.707 20.121 4.293l-1.414-1.414L3.293 18.293l1.414 1.414Z',
} as const;

/** Swap an existing icon's path in place, so toggling does not rebuild the node. */
export function setIconPath(svg: SVGSVGElement, path: string): void {
  svg.querySelector('path')?.setAttribute('d', path);
}

export function icon(path: string, size = 24): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}
