import { $, escapeHtml, toast } from './ui.js';
import { inr } from './ui.js';
import { categories } from './catalog.js';
import { icon } from './icons.js';
import * as selection from './selection.js';

const UNIT_LABEL = { rider: 'per rider', boat: 'per boat', group: 'per group' };

function cardMarkup(activity) {
  const riders = activity.minRiders === activity.maxRiders
    ? `${activity.minRiders} rider${activity.minRiders > 1 ? 's' : ''}`
    : `${activity.minRiders}-${activity.maxRiders} riders`;
  const unit = UNIT_LABEL[activity.unit] || `per ${activity.unit}`;

  return `
    <article class="ride-card" data-category="${escapeHtml(activity.category)}" data-activity="${escapeHtml(activity.id)}">
      <div class="ride-card__head">
        <span class="ride-card__icon">${icon(activity.icon)}</span>
        ${activity.tag ? `<span class="ride-card__tag">${escapeHtml(activity.tag)}</span>` : ''}
      </div>
      <h3 class="ride-card__name">${escapeHtml(activity.name)}</h3>
      <p class="ride-card__blurb">${escapeHtml(activity.blurb)}</p>
      <div class="ride-card__meta">
        <span>${escapeHtml(activity.duration)}</span>
        <span>${escapeHtml(riders)}</span>
        <span>${escapeHtml(unit)}</span>
      </div>
      <div class="ride-card__foot">
        <span class="ride-card__price">${inr(activity.price)}<span class="ride-card__unit">${escapeHtml(unit)}</span></span>
        <button class="btn btn--ghost btn--sm" type="button" data-add-ride aria-pressed="false">Add to booking</button>
      </div>
    </article>
  `;
}

export function initRides(catalog) {
  const grid = $('[data-ride-grid]');
  const filterBar = $('[data-filters]');
  if (!grid) return;

  if (!catalog || !catalog.activities?.length) {
    const note = $('[data-rides-note]');
    if (note) note.hidden = false;
    return;
  }

  $('[data-rides-note]')?.setAttribute('hidden', '');
  grid.innerHTML = catalog.activities.map(cardMarkup).join('');

  if (filterBar) {
    filterBar.innerHTML = categories(catalog).map((category, index) => `
      <button class="filter-pill" type="button" role="tab" aria-selected="${index === 0}" data-filter="${category.id}">
        ${escapeHtml(category.label)}
      </button>
    `).join('');

    filterBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      const filter = button.dataset.filter;
      Array.from(filterBar.children).forEach((item) => {
        item.setAttribute('aria-selected', String(item === button));
      });
      grid.querySelectorAll('.ride-card').forEach((card) => {
        const hide = filter !== 'all' && card.dataset.category !== filter;
        card.classList.toggle('is-filtered', hide);
      });
    });
  }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-add-ride]');
    if (!button) return;
    const card = button.closest('[data-activity]');
    const id = card?.dataset.activity;
    if (!id) return;

    if (selection.isSelected(id)) {
      selection.toggle(id, false);
      return;
    }

    const added = selection.toggle(id, true);
    if (!added) {
      toast(`Four rides is the most we can fit in one slot. Remove one first.`);
      return;
    }
    toast(`${card.querySelector('.ride-card__name').textContent} added to your booking request.`);
  });

  selection.subscribe((ids) => {
    grid.querySelectorAll('[data-activity]').forEach((card) => {
      const active = ids.includes(card.dataset.activity);
      card.classList.toggle('is-selected', active);
      const button = card.querySelector('[data-add-ride]');
      if (button) {
        button.setAttribute('aria-pressed', String(active));
        button.textContent = active ? 'Added' : 'Add to booking';
        button.classList.toggle('btn--primary', active);
        button.classList.toggle('btn--ghost', !active);
      }
    });
  });
}
