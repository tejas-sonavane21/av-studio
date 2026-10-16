/** Tiny helpers shared by every module. No framework, no build step. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** 3200 -> "₹3,200" */
export const inr = (value) => currency.format(Math.round(Number(value) || 0));

export const plainNumber = (value, decimals = 0) =>
  Number(value).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

let toastTimer = null;

/** Single transient message at the bottom of the viewport. */
export function toast(message, timeout = 3600) {
  const node = $('[data-toast]');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add('is-shown'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('is-shown');
    setTimeout(() => { node.hidden = true; }, 400);
  }, timeout);
}

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** rAF-throttled scroll/pointer handler. */
export function onFrame(handler) {
  let queued = false;
  let lastEvent = null;
  return (event) => {
    lastEvent = event;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      handler(lastEvent);
    });
  };
}

export function formatDateLong(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
