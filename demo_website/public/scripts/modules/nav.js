import { $, $$, onFrame } from './ui.js';

const THEME_KEY = 'aqualux:theme';

function initTheme() {
  const root = document.documentElement;
  const button = $('[data-theme-toggle]');
  const label = $('[data-theme-label]');

  let stored = null;
  try {
    stored = window.localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }

  const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'deep' : 'shore';
  const apply = (theme) => {
    root.dataset.theme = theme;
    const night = theme === 'deep';
    if (button) button.setAttribute('aria-pressed', String(night));
    if (label) label.textContent = night ? 'Switch to day water' : 'Switch to night water';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', night ? '#04121f' : '#04202f');
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode: theme just will not persist */
    }
  };

  apply(stored === 'deep' || stored === 'shore' ? stored : preferred);
  button?.addEventListener('click', () => {
    apply(root.dataset.theme === 'deep' ? 'shore' : 'deep');
  });
}

function initHeader() {
  const header = $('[data-header]');
  const bar = $('[data-scroll-bar]');
  const toTop = $('[data-to-top]');
  if (!header) return;

  const update = onFrame(() => {
    const y = window.scrollY;
    header.classList.toggle('is-stuck', y > 24);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(y / max, 1).toFixed(4) : 0})`;
    if (toTop) toTop.hidden = y < 700;
  });

  window.addEventListener('scroll', update, { passive: true });
  update();

  toTop?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function initActiveSection() {
  const links = $$('.site-nav a');
  if (!links.length || !('IntersectionObserver' in window)) return;

  const byId = new Map(links.map((link) => [link.getAttribute('href').slice(1), link]));
  const sections = Array.from(byId.keys())
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      links.forEach((link) => link.classList.remove('is-active'));
      byId.get(entry.target.id)?.classList.add('is-active');
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

  sections.forEach((section) => observer.observe(section));
}

function initMobileMenu() {
  const toggle = $('[data-menu-toggle]');
  const menu = $('[data-mobile-menu]');
  if (!toggle || !menu) return;

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    document.body.classList.toggle('is-locked', open);
  };

  toggle.addEventListener('click', () => setOpen(menu.hidden));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900 && !menu.hidden) setOpen(false);
  });
}

export function initNav() {
  initTheme();
  initHeader();
  initActiveSection();
  initMobileMenu();
}
