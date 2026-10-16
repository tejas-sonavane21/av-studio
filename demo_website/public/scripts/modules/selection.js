/**
 * One place owns "which rides are in this booking". The ride grid, the jetcar
 * configurator and the booking form all read and write it, so picking a jetcar
 * upstairs ticks the matching box downstairs.
 */

export const MAX_RIDES = 4;

const selected = new Set();
const listeners = new Set();

export const getSelection = () => Array.from(selected);
export const isSelected = (id) => selected.has(id);
export const selectionSize = () => selected.size;

function emit() {
  const snapshot = getSelection();
  listeners.forEach((listener) => listener(snapshot));
}

export function subscribe(listener) {
  listeners.add(listener);
  listener(getSelection());
  return () => listeners.delete(listener);
}

export function toggle(id, force) {
  if (!id) return false;
  const shouldSelect = force === undefined ? !selected.has(id) : Boolean(force);

  if (shouldSelect) {
    if (selected.has(id)) return true;
    if (selected.size >= MAX_RIDES) return false;
    selected.add(id);
  } else {
    selected.delete(id);
  }

  emit();
  return shouldSelect;
}

export function setSelection(ids = []) {
  selected.clear();
  ids.slice(0, MAX_RIDES).forEach((id) => selected.add(id));
  emit();
}

export const clear = () => setSelection([]);
