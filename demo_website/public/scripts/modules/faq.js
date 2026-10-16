import { $, escapeHtml } from './ui.js';

export function initFaq(catalog) {
  const root = $('[data-accordion]');
  if (!root || !catalog?.faqs?.length) return;

  root.innerHTML = catalog.faqs.map((faq, index) => `
    <div class="acc-item" data-acc-item>
      <h3 style="margin:0">
        <button class="acc-item__button" type="button" id="faq-${index}" aria-expanded="false" aria-controls="faq-panel-${index}">
          <span>${escapeHtml(faq.q)}</span>
          <span class="acc-item__icon" aria-hidden="true"></span>
        </button>
      </h3>
      <div class="acc-item__panel" id="faq-panel-${index}" role="region" aria-labelledby="faq-${index}">
        <p>${escapeHtml(faq.a)}</p>
      </div>
    </div>
  `).join('');

  const items = Array.from(root.querySelectorAll('[data-acc-item]'));

  const setOpen = (item, open) => {
    const button = item.querySelector('.acc-item__button');
    const panel = item.querySelector('.acc-item__panel');
    item.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    panel.style.height = open ? `${panel.scrollHeight}px` : '0px';
  };

  root.addEventListener('click', (event) => {
    const button = event.target.closest('.acc-item__button');
    if (!button) return;
    const item = button.closest('[data-acc-item]');
    const willOpen = !item.classList.contains('is-open');
    items.forEach((other) => setOpen(other, false));
    if (willOpen) setOpen(item, true);
  });

  // Height is set in px so it can animate; recompute on reflow so text never clips.
  window.addEventListener('resize', () => {
    items.forEach((item) => {
      if (!item.classList.contains('is-open')) return;
      const panel = item.querySelector('.acc-item__panel');
      panel.style.height = 'auto';
      const height = panel.scrollHeight;
      panel.style.height = `${height}px`;
    });
  });
}
