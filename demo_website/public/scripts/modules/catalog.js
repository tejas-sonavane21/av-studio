import { $, $$ } from './ui.js';

/**
 * The catalog is the single source of truth for rides, prices and slots.
 * server.js injects `data/catalog.json` into the page as inline JSON, so the
 * normal path is a parse with no network round trip. If the block is empty
 * (opened straight off disk, or the injection failed) we ask the API, and if
 * that fails too the caller falls back to the "start the server" note.
 */
export const CATALOG_SELECTOR = '#aqualux-catalog';

export async function loadCatalog() {
  const inline = $(CATALOG_SELECTOR);
  if (inline) {
    try {
      const parsed = JSON.parse(inline.textContent.trim() || '{}');
      if (parsed && Array.isArray(parsed.activities) && parsed.activities.length) return parsed;
    } catch {
      /* fall through to the API */
    }
  }

  try {
    const response = await fetch('/api/catalog', { headers: { accept: 'application/json' } });
    if (response.ok) {
      const parsed = await response.json();
      if (parsed && Array.isArray(parsed.activities)) return parsed;
    }
  } catch {
    /* offline preview: the sections render their notice instead */
  }

  return null;
}

const readPath = (source, path) =>
  path.split('.').reduce((value, key) => (value == null ? value : value[key]), source);

/**
 * Fills every [data-bind] node from the catalog:
 *   data-bind="brand.phoneDisplay"                       -> textContent
 *   data-bind-attr="href" data-bind-href="tel:brand.phone" -> href="tel:+91..."
 */
export function applyBrand(brand, root = document) {
  if (!brand) return;

  $$('[data-bind]', root).forEach((node) => {
    const value = readPath({ brand }, node.dataset.bind);
    if (value == null) return;
    node.textContent = value;

    const attr = node.dataset.bindAttr;
    const template = node.dataset.bindHref;
    if (attr && template) {
      const [prefix, path] = template.includes(':') && !template.startsWith('http')
        ? template.split(/:(?=[a-z]+\.|$)/)
        : ['', template];
      const target = readPath({ brand }, path || template);
      if (target) node.setAttribute(attr, `${prefix ? `${prefix}:` : ''}${target}`);
    }
  });

  const year = $('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  if (brand.name) document.title = `${brand.name} - Jetcar rides at ${brand.beach || 'the beach'}`;
}

/** Map every activity id to its record, for quick lookups in other modules. */
export const indexActivities = (catalog) =>
  new Map((catalog.activities || []).map((activity) => [activity.id, activity]));

export const categories = (catalog) => {
  const order = ['jetcar', 'watersport', 'leisure', 'retreat'];
  const present = new Set((catalog.activities || []).map((activity) => activity.category));
  return [
    { id: 'all', label: 'All rides' },
    ...order.filter((id) => present.has(id)).map((id) => ({
      id,
      label: {
        jetcar: 'Jetcars',
        watersport: 'Watersports',
        leisure: 'Beach and leisure',
        retreat: 'Retreat',
      }[id] || id,
    })),
  ];
};
