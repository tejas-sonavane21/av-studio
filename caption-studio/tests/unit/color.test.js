/**
 * color.test.js — the hex normalisation behind the colour pickers.
 *
 * The rule under test is one-directional: the document may hold any CSS colour, and the picker is
 * given the closest thing it can display *without* the document being rewritten to match.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isHexColor, toHexColor } from '../../src/util/color.js';

test('a plain six-digit hex passes through, lower-cased', () => {
  assert.equal(toHexColor('#22C55E'), '#22c55e');
  assert.equal(toHexColor('#000000'), '#000000');
  assert.equal(toHexColor('  #ff00ff  '), '#ff00ff');
});

test('shorthand hex is expanded — a colour input rejects #abc', () => {
  assert.equal(toHexColor('#abc'), '#aabbcc');
  assert.equal(toHexColor('#F0A'), '#ff00aa');
});

test('a colour a picker cannot represent falls back rather than showing black', () => {
  // an alpha colour, a named colour, a function colour, nothing at all
  assert.equal(toHexColor('rgba(34,197,94,0.5)'), '#22c55e');
  assert.equal(toHexColor('lime'), '#22c55e');
  assert.equal(toHexColor(''), '#22c55e');
  assert.equal(toHexColor(null), '#22c55e');
  assert.equal(toHexColor(undefined, '#ff0000'), '#ff0000');
});

test('isHexColor accepts exactly the two shapes an input can hold', () => {
  assert.equal(isHexColor('#abc'), true);
  assert.equal(isHexColor('#AABBCC'), true);
  assert.equal(isHexColor('#abcd'), false);
  assert.equal(isHexColor('rgb(0,0,0)'), false);
});
