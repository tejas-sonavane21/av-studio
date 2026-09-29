/**
 * store/store.js — a tiny observable state container.
 *
 * Deliberately framework-free. Undo/redo (store/history.js) and command actions
 * (store/actions.js) will be layered on top in a later phase; this is the minimal
 * core the Phase 0/1 UI needs.
 */

export function createStore(initialState = {}) {
  let state = initialState;
  const listeners = new Set();

  const getState = () => state;

  const setState = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
    if (next === state) return state;
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { getState, setState, subscribe };
}
