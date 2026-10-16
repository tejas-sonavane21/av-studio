/**
 * Line icons, 24x24, currentColor. Kept inline so the page ships with no icon
 * font, no sprite request and no third party dependency.
 */

const wrap = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  jetcar: wrap('<path d="M3 14h18l-2.4 5H5.4z"/><path d="M8 11l3-4 3 4"/><path d="M2 7.5h4M18 7.5h4"/><path d="M9 21.5l-1.5 1.5M15 21.5l1.5 1.5"/>'),
  instructor: wrap('<circle cx="12" cy="7" r="3.2"/><path d="M5.5 21c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M15 4.5l2.5-1.5"/>'),
  deck: wrap('<path d="M12 3c4.4 0 8 3.2 8 7.2H4C4 6.2 7.6 3 12 3z"/><path d="M12 10.2V20"/><path d="M8 21.5h8"/>'),
  clock: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.6 2.2"/>'),
  pin: wrap('<path d="M12 21.5s7-6.6 7-11.9A7 7 0 105 9.6c0 5.3 7 11.9 7 11.9z"/><circle cx="12" cy="9.6" r="2.6"/>'),
  phone: wrap('<path d="M7 3.5H4.8A1.8 1.8 0 003 5.4C3.5 13 10.9 20.4 18.6 21a1.8 1.8 0 001.9-1.8V17l-4.4-1.7-1.7 2a13.2 13.2 0 01-5.2-5.2l2-1.7z"/>'),
  instagram: wrap('<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.9" r="1.1" fill="currentColor" stroke="none"/>'),
  mail: wrap('<rect x="2.8" y="5" width="18.4" height="14" rx="3.4"/><path d="M4.4 7.6l7.6 5.6 7.6-5.6"/>'),
  parasail: wrap('<path d="M3.5 6.5a10.5 8.5 0 0117 0z"/><path d="M12 6.5v9"/><circle cx="12" cy="18" r="2.6"/>'),
  boat: wrap('<path d="M3 15.5h18l-2.6 4.5H5.6z"/><path d="M12 4v10"/><path d="M8 10.5L12 4l4 6.5z"/>'),
  banana: wrap('<path d="M2.6 11.5c3.4 6.4 12.4 9 18.8 4.4"/><path d="M6 12.6l1.2 1.4M10 14.6l1.2 1.4M14.2 15.4l1.3 1.2"/>'),
  kite: wrap('<path d="M12 2.8l5.4 6.4L12 15.6 6.6 9.2z"/><path d="M12 15.6c2.4 1.8-.8 3.4 1.2 5.6"/>'),
  atv: wrap('<circle cx="6" cy="17" r="3.2"/><circle cx="18" cy="17" r="3.2"/><path d="M6.4 16.6l3.4-8h5.2l3 8"/><path d="M9 8.6h6.4"/>'),
  kayak: wrap('<path d="M2 12c4.4-3.4 15.6-3.4 20 0-4.4 3.4-15.6 3.4-20 0z"/><path d="M12 4v16"/>'),
  sparkle: wrap('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
};

export const icon = (name) => icons[name] || icons.sparkle;
