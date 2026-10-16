import { $, escapeHtml, inr } from './ui.js';

function slotMarkup(slot) {
  return `
    <article class="slot-card">
      <span class="slot-card__sun" aria-hidden="true"></span>
      <h3 class="slot-card__name">${escapeHtml(slot.name)}</h3>
      <p class="slot-card__window">${escapeHtml(slot.window)}</p>
      <p class="slot-card__note">${escapeHtml(slot.note)}</p>
    </article>
  `;
}

function packageMarkup(pack) {
  return `
    <article class="package-card${pack.highlight ? ' is-highlight' : ''}">
      <div class="package-card__head">
        <h3 class="package-card__name">${escapeHtml(pack.name)}</h3>
        ${pack.highlight ? '<span class="package-card__best">Most booked</span>' : ''}
      </div>
      <p class="package-card__price">${inr(pack.price)} <small>${escapeHtml(pack.for || '')}</small></p>
      <p class="package-card__summary">${escapeHtml(pack.summary)}</p>
      <ul class="package-card__list">
        ${pack.includes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
      <a class="btn btn--ghost btn--block" href="#book" data-package="${escapeHtml(pack.id)}">Enquire about this package</a>
    </article>
  `;
}

function statMarkup(stat) {
  const decimals = stat.decimals || 0;
  return `
    <div class="stat">
      <span class="stat__value" data-counter="${stat.value}" data-counter-decimals="${decimals}" data-counter-suffix="${escapeHtml(stat.suffix || '')}">0</span>
      <span class="stat__label">${escapeHtml(stat.label)}</span>
    </div>
  `;
}

export function initPricing(catalog) {
  if (!catalog) return;

  const slotRow = $('[data-slot-row]');
  if (slotRow && catalog.slots?.length) {
    slotRow.innerHTML = catalog.slots.map(slotMarkup).join('');
  }

  const packageGrid = $('[data-package-grid]');
  if (packageGrid && catalog.packages?.length) {
    packageGrid.innerHTML = catalog.packages.map(packageMarkup).join('');
    packageGrid.addEventListener('click', (event) => {
      const link = event.target.closest('[data-package]');
      if (!link) return;
      const pack = catalog.packages.find((item) => item.id === link.dataset.package);
      const notes = document.querySelector('textarea[name="notes"]');
      if (pack && notes && !notes.value.trim()) {
        notes.value = `Interested in the ${pack.name} package.`;
      }
    });
  }

  const statGrid = $('[data-stat-grid]');
  if (statGrid && catalog.stats?.length) {
    statGrid.innerHTML = catalog.stats.map(statMarkup).join('');
  }
}
