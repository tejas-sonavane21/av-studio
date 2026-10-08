/**
 * render/animation.js — easings and the animation preset registry (plan §13).
 *
 * A preset is a *pure transform* over a reusable `node` scratch object holding
 * `{ opacity, scale, dx, dy }`. Presets never touch the canvas: `draw-text.js` applies the
 * resulting transform, which keeps "what it looks like" testable in Node with no browser.
 *
 * Scopes:
 *   - `block` — animated over `[block.start, block.start + inDur]`
 *   - `word`  — animated over `[word.start,  word.start  + inDur]`
 *
 * IMPORTANT: the **default** for the Veed parity template is `{ in: 'reveal' }`, and `reveal`
 * returns the identity transform. v10's output was completely static text plus the progressive
 * reveal, so any non-identity default would break parity. `reveal` therefore must never scale,
 * fade or move — the reveal is a *visibility* rule owned by `time.js`, not an animation.
 *
 * Scratch objects are reused per scope so the render loop allocates nothing per frame (plan §13.5).
 */

/** Named easing functions, each mapping 0..1 → 0..1. */
export const EASINGS = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  sinOut: (t) => Math.sin((t * Math.PI) / 2),
  // Smoothstep: starts gently, speeds through the middle, eases into the end. This is the shape a
  // *drawn* line wants — the pen presses down slowly, sweeps, and settles — which is why the
  // emphasis underline grows on this curve rather than on a linear ramp.
  smoothInOut: (t) => t * t * (3 - 2 * t),
  squareIn: (t) => t * t * t * t,
  backOut: (t) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
};

export function ease(name, t) {
  const fn = EASINGS[name] ?? EASINGS.linear;
  return fn(t);
}

/**
 * The easing an emphasis decoration is *drawn* on. Named here (rather than inline in the decoration
 * layer) because it is the one thing that decides whether the underline reads as "alive" or as a
 * rectangle that happens to be narrower for a few frames.
 */
export const DRAW_EASE = 'smoothInOut';

/** The identity transform. Returned (never a fresh object) by presets that do nothing. */
export const IDENTITY = Object.freeze({ opacity: 1, scale: 1, dx: 0, dy: 0 });

/** Built-in presets. `apply(node, t, easing)` mutates `node` in place. */
const PRESETS = new Map();

export function registerAnimation(name, def) {
  PRESETS.set(name, def);
  return def;
}

export function getAnimation(name) {
  return PRESETS.get(name) ?? null;
}

export function animationNames() {
  return [...PRESETS.keys()];
}

/**
 * Resolve the transform for one word at time `t`.
 *
 * `anim` is the document's `animation` object: `{ in, inDur, out, outDur }`.
 * `scope` is `{ start, end }` for the thing being animated (word or block).
 * Writes into `out` (a reusable scratch object) and returns it.
 */
export function animationAt(anim, scope, t, out = { opacity: 1, scale: 1, dx: 0, dy: 0 }) {
  out.opacity = 1;
  out.scale = 1;
  out.dx = 0;
  out.dy = 0;
  if (!anim) return out;

  const { in: inName, inDur = 0, out: outName, outDur = 0, inEase, outEase } = anim;

  const inDef = inName ? getAnimation(inName) : null;
  if (inDef && inDur > 0) {
    const p = clamp01((t - scope.start) / inDur);
    inDef.apply(out, p, (x) => ease(inEase, x));
  }
  const outDef = outName ? getAnimation(outName) : null;
  if (outDef && outDur > 0) {
    const p = clamp01((scope.end - t) / outDur);
    outDef.apply(out, p, (x) => ease(outEase, x));
  }
  return out;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** How many px a `dx`/`dy` of 1.0 means — offsets are expressed as a fraction of font size. */
export const OFFSET_UNIT = 'fontSize';

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

// The default. Deliberately the identity transform: the reveal is a visibility rule.
registerAnimation('reveal', { scope: 'word', apply() {} });

// Also the identity, but at block scope — everything appears at once with the block.
registerAnimation('none', { scope: 'block', apply() {} });

registerAnimation('fade', { scope: 'word', apply(node, p, e) { node.opacity *= e(p); } });

registerAnimation('slideUp', {
  scope: 'word',
  apply(node, p, e) {
    const k = 1 - e(p);
    node.opacity *= e(p);
    node.dy += k; // +1 font size below, sliding up into place
  },
});

registerAnimation('slideDown', {
  scope: 'word',
  apply(node, p, e) {
    const k = 1 - e(p);
    node.opacity *= e(p);
    node.dy -= k;
  },
});

registerAnimation('slideLeft', {
  scope: 'word',
  apply(node, p, e) {
    const k = 1 - e(p);
    node.opacity *= e(p);
    node.dx += k;
  },
});

registerAnimation('slideRight', {
  scope: 'word',
  apply(node, p, e) {
    const k = 1 - e(p);
    node.opacity *= e(p);
    node.dx -= k;
  },
});

registerAnimation('zoomIn', { scope: 'word', apply(node, p, e) { node.scale *= e(p); } });

/**
 * Scale overshoot: grows past 1 around the midpoint, then settles exactly at 1.
 * The bump is on `k` (the eased progress) rather than on `p`, so the preset overshoots whatever
 * easing is configured — with a linear ramp the old `p`-based form never actually exceeded 1 and
 * the "pop" was just a slow grow.
 */
registerAnimation('pop', {
  scope: 'word',
  apply(node, p, e) {
    const k = e(p);
    node.scale *= 0.55 + 0.45 * k + 0.3 * Math.sin(Math.PI * k);
  },
});

/** Two decaying bounces, then settle. */
registerAnimation('bounce', {
  scope: 'word',
  apply(node, p, e) {
    const k = 1 - e(p);
    node.opacity *= Math.min(1, p * 3);
    node.dy -= Math.abs(Math.sin(p * Math.PI * 2)) * k;
    node.scale *= 1 - 0.15 * k;
  },
});

registerAnimation('zoomOut', { scope: 'word', apply(node, p, e) { node.scale *= 2 - e(p); } });

// Presets whose whole effect lives in the *decoration* layer (a box or colour behind the
// active word). They are identity transforms, registered so templates can reference them and
// `animationNames()` documents the vocabulary. `decorations.js` reads the same names.
for (const name of ['typewriter', 'typewriterCursor', 'karaoke', 'highlight', 'boxHighlight', 'colourHighlight']) {
  registerAnimation(name, { scope: 'word', decorationDriven: true, apply() {} });
}
