/**
 * templates.test.js — the template registry.
 *
 * The registry's job is to make a template *data*, and the tests' job is to hold it to that:
 * every template is validated at import, the verified Veed original leads the list, and a picker's
 * preview card is derived from the template's own defaults rather than written beside them — because
 * a hand-written card is the one thing that silently drifts out of date.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEMPLATES,
  TEMPLATE_ORIGINS,
  allSwatches,
  getTemplate,
  hasTemplate,
  templateDefaults,
  templateIds,
  templateSwatch,
  templatesByOrigin,
  validateTemplate,
} from '../../src/templates/index.js';
import { DISPLAY_MODES } from '../../src/model/schema.js';
import { EMPHASIS_SOURCES, REVEAL_MODES } from '../../src/render/time.js';
import { getFont, fontFamilies } from '../../src/fonts/registry.js';

const validDef = () => ({
  id: 'test-template',
  name: 'Test — Template',
  origin: 'generic',
  description: 'for the validator',
  defaults: { font: { family: 'Inter', sizeUnit: 'w' }, display: 'NORMAL', reveal: 'progressive', wrapWidth: 0.8 },
});

test('the registry holds ten templates with unique, ordered, kebab-case ids', () => {
  assert.equal(TEMPLATES.length, 10);
  const ids = templateIds();
  assert.deepEqual(ids, TEMPLATES.map((t) => t.id));
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/, `${id} is kebab-case`);
});

test('the verified Veed original is first and is the document default', () => {
  assert.equal(TEMPLATES[0].id, 'veed-auto-highlight');
  assert.equal(TEMPLATES[0].origin, 'veed');
  assert.equal(getTemplate('veed-auto-highlight').defaults.font.size, 0.036);
});

test('every registered template passes validation', () => {
  for (const def of TEMPLATES) {
    assert.equal(validateTemplate(def, { where: 'test' }), def);
    assert.ok(def.name.length > 0, `${def.id} has a name`);
    assert.ok(TEMPLATE_ORIGINS.includes(def.origin), `${def.id} origin`);
    assert.ok(def.description, `${def.id} has a description (the picker shows it)`);
  }
});

test('templates group by origin in picker order', () => {
  const groups = templatesByOrigin();
  assert.deepEqual(
    groups.map((g) => [g.origin, g.templates.length]),
    [
      ['veed', 3],
      ['capcut', 4],
      ['generic', 3],
    ],
  );
  // and every template appears exactly once
  assert.equal(groups.flatMap((g) => g.templates).length, TEMPLATES.length);
});

test('lookup helpers behave for known and unknown ids', () => {
  assert.equal(hasTemplate('capcut-neon'), true);
  assert.equal(hasTemplate('nope'), false);
  assert.equal(getTemplate('nope'), null);
  assert.equal(getTemplate(null), null);
  assert.equal(templateDefaults('nope'), null);
  assert.equal(templateDefaults('capcut-neon').font.family, 'Poppins');
  // the registry hands out the frozen definition, never a copy the caller could mutate
  assert.equal(getTemplate('veed-karaoke'), TEMPLATES.find((t) => t.id === 'veed-karaoke'));
});

test('validateTemplate rejects each class of malformed definition', () => {
  const cases = [
    [null, /not an object/],
    [{ ...validDef(), id: undefined }, /string `id`/],
    [{ ...validDef(), id: 'Not-Kebab' }, /kebab-case/],
    [{ ...validDef(), name: '' }, /missing a `name`/],
    [{ ...validDef(), origin: 'veed-ish' }, /expected one of veed, capcut, generic/],
    [{ ...validDef(), defaults: null }, /missing `defaults`/],
    [{ ...validDef(), defaults: { ...validDef().defaults, display: 'GLOW' } }, new RegExp(DISPLAY_MODES.join(', '))],
    [{ ...validDef(), defaults: { ...validDef().defaults, reveal: 'sometimes' } }, new RegExp(REVEAL_MODES.join(', '))],
    [
      { ...validDef(), defaults: { ...validDef().defaults, emphasis: { source: 'loudest' } } },
      new RegExp(EMPHASIS_SOURCES.join(', ')),
    ],
    [
      // the check that earns its keep: a misspelled family would otherwise render a fallback face
      { ...validDef(), defaults: { ...validDef().defaults, font: { family: 'Montserat' } } },
      /unknown font family "Montserat"/,
    ],
    [{ ...validDef(), defaults: { ...validDef().defaults, font: { family: 'Inter', sizeUnit: 'px' } } }, /sizeUnit/],
    [{ ...validDef(), defaults: { ...validDef().defaults, wrapWidth: 1.4 } }, /wrapWidth/],
    [{ ...validDef(), defaults: { ...validDef().defaults, wrapWidth: 0 } }, /wrapWidth/],
  ];
  for (const [def, pattern] of cases) {
    assert.throws(() => validateTemplate(def), pattern, `expected a throw for ${JSON.stringify(def)?.slice(0, 60)}`);
  }
  // …and the error names the offending template
  assert.throws(() => validateTemplate({ ...validDef(), id: 'bad-one', name: '' }), /bad-one/);
});

test('validateTemplate only rejects fonts that are really unknown', () => {
  for (const family of fontFamilies()) {
    assert.ok(getFont(family), `${family} is in the registry`);
    assert.doesNotThrow(() => validateTemplate({ ...validDef(), defaults: { ...validDef().defaults, font: { family } } }));
  }
});

test('swatches are derived from the template defaults, never hand-written', () => {
  for (const def of TEMPLATES) {
    const s = templateSwatch(def.id);
    assert.equal(s.id, def.id);
    assert.equal(s.name, def.name);
    assert.equal(s.origin, def.origin);
    assert.equal(s.description, def.description);
    assert.equal(s.fill, def.defaults.fill?.color ?? '#ffffff');
    assert.equal(s.fontFamily, def.defaults.font?.family ?? null);
    assert.equal(s.fontWeight, def.defaults.font?.weight ?? null);
    assert.equal(s.uppercase, def.defaults.font?.case === 'upper');
    assert.equal(s.emphasis, def.defaults.emphasis?.decoration ?? 'none');
    assert.equal(s.emphasisSource, def.defaults.emphasis?.source ?? 'keyword');
    assert.equal(s.reveal, def.defaults.reveal ?? 'progressive');
    assert.ok(s.strokeWidth === (def.defaults.stroke?.width ?? 0));
    assert.equal(s.stroke, def.defaults.stroke?.width > 0 ? def.defaults.stroke.color : null);
  }
  assert.equal(templateSwatch('nope'), null);
});

test('a box colour only becomes a swatch background when a display mode paints it', () => {
  // every template carries a box colour, but only box-drawing displays may use it as the card's
  // background — otherwise a plain text template would preview as a solid block of colour
  for (const def of TEMPLATES) {
    const boxVisible = ['BLOCK', 'LINE_BLOCK_ROUND', 'LINE_BLOCK_HARD'].includes(def.defaults.display ?? '');
    const s = templateSwatch(def.id);
    assert.equal(s.background, boxVisible ? (def.defaults.box?.color ?? null) : null, def.id);
  }
  assert.ok(TEMPLATES.some((t) => t.defaults.display === 'NORMAL' && !templateSwatch(t.id).background));
});

test('every template is renderable: fonts exist, reveal and emphasis are in vocabulary', () => {
  for (const def of TEMPLATES) {
    const d = def.defaults;
    assert.ok(getFont(d.font.family), `${def.id}: font ${d.font.family}`);
    assert.ok((getFont(d.font.family).weights ?? []).includes(d.font.weight), `${def.id}: weight ${d.font.weight} exists`);
    assert.ok([undefined, null, ...REVEAL_MODES].includes(d.reveal), `${def.id}: reveal`);
    assert.ok([undefined, null, ...EMPHASIS_SOURCES].includes(d.emphasis?.source), `${def.id}: emphasis source`);
    if (d.emphasis?.decoration && d.emphasis.decoration !== 'none') {
      assert.ok(['underline', 'highlight'].includes(d.emphasis.decoration), `${def.id}: decoration vocabulary`);
    }
  }
});

test('allSwatches mirrors the registry order', () => {
  const all = allSwatches();
  assert.equal(all.length, TEMPLATES.length);
  assert.deepEqual(all.map((s) => s.id), templateIds());
  assert.deepEqual(all.map((s) => s.origin), ['veed', 'veed', 'veed', 'capcut', 'capcut', 'capcut', 'capcut', 'generic', 'generic', 'generic']);
});

test('the karaoke template is the one that uses a playhead-driven emphasis', () => {
  const karaoke = getTemplate('veed-karaoke').defaults;
  assert.equal(karaoke.emphasis.source, 'active');
  assert.equal(karaoke.emphasis.decoration, 'highlight');
  assert.equal(getTemplate('veed-auto-highlight').defaults.emphasis.source, 'keyword');
});
