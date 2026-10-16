import { $, $$, inr, escapeHtml, toast } from './ui.js';
import * as selection from './selection.js';

/**
 * Model and finish picker. The preview is one inline SVG whose three paint
 * colours come from CSS custom properties, so "repainting" a jetcar is three
 * style writes rather than a second asset.
 */

const state = { model: 0, finish: 0, catalog: null };

function specMarkup(model) {
  const rows = [
    ['Power', model.power],
    ['Top speed', model.topSpeed],
    ['Rides', model.seats],
    ['Longest run', model.duration],
  ];
  return rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
}

function paint() {
  const { catalog, model: modelIndex, finish: finishIndex } = state;
  const model = catalog.jetcars[modelIndex];
  const finish = catalog.jetcarFinishes[finishIndex];
  const target = $('[data-finish-target]');
  const preview = $('.jetcar--preview');

  if (target) {
    target.style.setProperty('--finish-hull', finish.hull);
    target.style.setProperty('--finish-accent', finish.accent);
    target.style.setProperty('--finish-trim', finish.trim);
  }
  if (preview) {
    preview.classList.remove('is-spinning');
    void preview.offsetWidth; // restart the bob so the swap reads as a change
    preview.classList.add('is-spinning');
  }

  const name = $('[data-config-name]');
  const finishName = $('[data-config-finish-name]');
  const price = $('[data-config-price]');
  const duration = $('[data-config-duration]');
  if (name) name.textContent = model.name;
  if (finishName) finishName.textContent = finish.name;
  if (price) price.textContent = inr(model.price);
  if (duration) duration.textContent = `${model.duration} ride, per rider`;

  const specs = $('[data-spec-list]');
  if (specs) specs.innerHTML = specMarkup(model);

  const highlights = $('[data-highlight-list]');
  if (highlights) {
    highlights.innerHTML = model.highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  }

  $$('[data-model-list] .model-option').forEach((button, index) => {
    button.setAttribute('aria-checked', String(index === modelIndex));
  });
  $$('[data-finish-list] .finish-swatch').forEach((button, index) => {
    button.setAttribute('aria-checked', String(index === finishIndex));
  });

  const readout = $('.configurator__stage');
  readout?.setAttribute('data-active-model', model.id);
}

export function initConfigurator(catalog) {
  const modelList = $('[data-model-list]');
  if (!modelList) return;

  if (!catalog || !catalog.jetcars?.length) {
    const note = $('[data-catalog-note]', modelList.parentElement) || $('[data-catalog-note]');
    if (note) note.hidden = false;
    return;
  }

  state.catalog = catalog;
  state.model = 0;
  state.finish = 0;

  const note = $('[data-catalog-note]', modelList.parentElement);
  if (note) note.hidden = true;

  modelList.innerHTML = catalog.jetcars.map((model, index) => `
    <button class="model-option" type="button" role="radio" aria-checked="${index === 0}" data-model-index="${index}">
      <span class="model-option__dot" aria-hidden="true"></span>
      <span class="model-option__text">
        <span class="model-option__name">${escapeHtml(model.name)}</span>
        <span class="model-option__meta">${escapeHtml(model.power)} &middot; ${escapeHtml(model.topSpeed)} &middot; ${escapeHtml(model.duration)}</span>
      </span>
      <span class="model-option__price">${inr(model.price)}</span>
    </button>
  `).join('');

  const finishList = $('[data-finish-list]');
  if (finishList) {
    finishList.innerHTML = catalog.jetcarFinishes.map((finish, index) => `
      <button class="finish-swatch" type="button" role="radio" aria-checked="${index === 0}" data-finish-index="${index}">
        <span class="finish-swatch__chip" style="background: linear-gradient(150deg, ${finish.hull}, ${finish.accent})" aria-hidden="true"></span>
        <span>${escapeHtml(finish.name)}</span>
      </button>
    `).join('');
  }

  modelList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-model-index]');
    if (!button) return;
    state.model = Number(button.dataset.modelIndex);
    paint();
  });

  finishList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-finish-index]');
    if (!button) return;
    state.finish = Number(button.dataset.finishIndex);
    paint();
  });

  $('[data-config-reserve]')?.addEventListener('click', () => {
    const model = catalog.jetcars[state.model];
    const activityId = model.activityId || 'jetcar-discovery';
    selection.setSelection([activityId]);
    const form = $('[data-booking-form]');
    form?.classList.add('is-flagged');
    setTimeout(() => form?.classList.remove('is-flagged'), 1600);
    document.getElementById('book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`${model.name} added to your booking request.`);
  });

  paint();
}
