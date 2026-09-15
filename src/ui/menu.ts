// The menu behind a card's kebab.
//
// Shaped like YouTube's: a dark rounded sheet of 36px rows, each a 24px icon
// and a 14px label, opened beside the button and closed by anything that would
// close a popup — a click elsewhere, Escape, or navigating away.
//
// It is appended to <body> rather than to the card, so a card with `overflow:
// hidden` or a stacking context cannot clip it. That is also why
// content/index.ts closes it on navigation: anything on <body> outlives the
// page it was opened from.

import { icon } from '@/ui/icons';

export interface MenuItem {
  label: string;
  /** SVG path, 24x24. */
  path: string;
  onClick: () => void | Promise<void>;
  /** Keep the menu open — for an item that swaps the menu's own contents. */
  keepOpen?: boolean;
}

const MENU_ID = 'localtube-card-menu';

export function closeCardMenu(): void {
  document.getElementById(MENU_ID)?.remove();
}

/** Open (or replace) the menu anchored to `button`. */
export function openCardMenu(button: HTMLElement, items: MenuItem[]): void {
  closeCardMenu();

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'lt-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'lt-menu-item';
    row.setAttribute('role', 'menuitem');
    row.append(icon(item.path), Object.assign(document.createElement('span'), { textContent: item.label }));
    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!item.keepOpen) closeCardMenu();
      void item.onClick();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // Positioned after insertion, so the sheet's real size decides whether it
  // opens downward or upward and how far left it has to come.
  const anchor = button.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    Math.max(margin, anchor.right - box.width),
    window.innerWidth - box.width - margin,
  );
  const below = anchor.bottom + box.height + margin < window.innerHeight;
  const top = below ? anchor.bottom + 4 : Math.max(margin, anchor.top - box.height - 4);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  // Bound on the next tick, or the click that opened the menu closes it.
  window.setTimeout(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (menu.contains(event.target as Node)) return;
      closeCardMenu();
      document.removeEventListener('click', onDocClick);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeCardMenu();
});
