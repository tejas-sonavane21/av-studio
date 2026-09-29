/**
 * util/log.js — tiny scoped logger.
 * Kept deliberately dependency-free so it works in the browser and in Node tests.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let currentLevel = typeof process !== 'undefined' && process.env?.CAPTION_STUDIO_DEBUG
  ? LEVELS.debug
  : LEVELS.info;

export function setLogLevel(nameOrNumber) {
  currentLevel = typeof nameOrNumber === 'number' ? nameOrNumber : (LEVELS[nameOrNumber] ?? LEVELS.info);
}

export function createLogger(scope) {
  const emit = (level, args) => {
    if (LEVELS[level] > currentLevel) return;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${scope}]`, ...args);
  };
  return {
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
  };
}
