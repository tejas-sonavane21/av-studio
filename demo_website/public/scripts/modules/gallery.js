import { $, $$ } from './ui.js';

function initDrag(strip) {
  let dragging = false;
  let startX = 0;
  let startScroll = 0;
  let distance = 0;

  strip.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') return;
    dragging = true;
    distance = 0;
    startX = event.clientX;
    startScroll = strip.scrollLeft;
    strip.classList.add('is-dragging');
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = event.clientX - startX;
    distance = Math.max(distance, Math.abs(delta));
    strip.scrollLeft = startScroll - delta;
  });

  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    strip.classList.remove('is-dragging');
  });

  // A drag should not count as a tap on the frame underneath it.
  strip.addEventListener('click', (event) => {
    if (distance > 6) {
      event.preventDefault();
      event.stopPropagation();
      distance = 0;
    }
  }, true);

  strip.addEventListener('keydown', (event) => {
    const step = strip.querySelector('.gallery-card')?.offsetWidth || 260;
    if (event.key === 'ArrowRight') {
      strip.scrollBy({ left: step + 16, behavior: 'smooth' });
      event.preventDefault();
    }
    if (event.key === 'ArrowLeft') {
      strip.scrollBy({ left: -step - 16, behavior: 'smooth' });
      event.preventDefault();
    }
  });
}

function initLightbox() {
  const lightbox = $('[data-lightbox]');
  const artFrame = $('[data-lightbox-art]');
  const caption = $('[data-lightbox-caption]');
  if (!lightbox || !artFrame || !caption) return;

  let lastFocus = null;

  const open = (card) => {
    lastFocus = document.activeElement;
    const theme = card.dataset.themeArt;
    if (theme) artFrame.dataset.themeArt = theme;
    else delete artFrame.dataset.themeArt;
    const source = card.querySelector('.gallery-card__art');
    if (source) artFrame.innerHTML = source.innerHTML;
    caption.textContent = card.dataset.caption || '';
    lightbox.hidden = false;
    document.body.classList.add('is-locked');
    $('[data-lightbox-close]', lightbox)?.focus();
  };

  const close = () => {
    lightbox.hidden = true;
    document.body.classList.remove('is-locked');
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
  };

  $$('[data-gallery]').forEach((card) => {
    // The art element carries the theme so CSS can tint tiles and the lightbox alike.
    const art = card.querySelector('.gallery-card__art');
    if (art && card.dataset.themeArt) art.dataset.themeArt = card.dataset.themeArt;
    card.addEventListener('click', () => open(card));
  });

  $('[data-lightbox-close]', lightbox)?.addEventListener('click', close);
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !lightbox.hidden) close();
  });
}

export function initGallery() {
  const strip = $('[data-gallery-strip]');
  if (!strip) return;
  initDrag(strip);
  initLightbox();
}
