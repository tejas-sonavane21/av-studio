import { $, $$, escapeHtml, onFrame } from './ui.js';

export function initReviews(catalog) {
  const track = $('[data-review-track]');
  const dots = $('[data-review-dots]');
  if (!track || !catalog?.testimonials?.length) return;

  const reviews = catalog.testimonials;
  let index = 0;
  let timer = null;

  track.innerHTML = reviews.map((review) => `
    <figure class="review__slide">
      <blockquote>${escapeHtml(review.quote)}</blockquote>
      <figcaption class="review__who">
        <strong>${escapeHtml(review.name)}</strong>
        <span>${escapeHtml(review.from)}</span>
        ${review.tag ? `<span class="review__tag">${escapeHtml(review.tag)}</span>` : ''}
      </figcaption>
    </figure>
  `).join('');

  if (dots) {
    dots.innerHTML = reviews.map((review, i) => `
      <button type="button" aria-current="${i === 0}" aria-label="Show review ${i + 1}: ${escapeHtml(review.name)}"></button>
    `).join('');
  }

  const slides = $$('.review__slide', track);

  const go = (next) => {
    index = (next + reviews.length) % reviews.length;
    track.style.transform = `translateX(-${index * 100}%)`;
    slides.forEach((slide, i) => slide.classList.toggle('is-active', i === index));
    $$('button', dots || track.parentElement).forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)));
  };

  const restart = () => {
    clearInterval(timer);
    timer = setInterval(() => go(index + 1), 7000);
  };

  $('[data-review-next]')?.addEventListener('click', () => { go(index + 1); restart(); });
  $('[data-review-prev]')?.addEventListener('click', () => { go(index - 1); restart(); });
  dots?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    go(Array.from(dots.children).indexOf(button));
    restart();
  });

  const stage = $('.review__stage');
  stage?.addEventListener('pointerenter', () => clearInterval(timer));
  stage?.addEventListener('pointerleave', restart);
  stage?.addEventListener('focusin', () => clearInterval(timer));
  stage?.addEventListener('focusout', restart);

  // Touch swipe: 40px left or right is enough to advance.
  let touchX = null;
  stage?.addEventListener('touchstart', (event) => { touchX = event.touches[0]?.clientX ?? null; }, { passive: true });
  stage?.addEventListener('touchend', (event) => {
    if (touchX === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? touchX) - touchX;
    if (Math.abs(delta) > 40) {
      go(index + (delta < 0 ? 1 : -1));
      restart();
    }
    touchX = null;
  });

  const keepCentred = onFrame(() => {
    track.style.transition = 'none';
    track.style.transform = `translateX(-${index * 100}%)`;
    requestAnimationFrame(() => { track.style.transition = ''; });
  });
  window.addEventListener('resize', keepCentred);

  go(0);
  restart();
}
