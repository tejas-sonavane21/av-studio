import { $, $$, onFrame, prefersReducedMotion } from './ui.js';

function initPreloader() {
  const preloader = $('[data-preloader]');
  if (!preloader) return;

  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    preloader.classList.add('is-done');
    preloader.setAttribute('aria-hidden', 'true');
    setTimeout(() => { preloader.hidden = true; }, 800);
  };

  // Never hold the page hostage: whichever happens first wins.
  window.addEventListener('load', () => setTimeout(dismiss, 350), { once: true });
  setTimeout(dismiss, 1400);
}

function initCursorGlow() {
  const glow = $('[data-cursor-glow]');
  if (!glow || prefersReducedMotion()) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;

  const move = onFrame((event) => {
    glow.style.setProperty('--glow-x', `${event.clientX}px`);
    glow.style.setProperty('--glow-y', `${event.clientY}px`);
  });

  window.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    glow.classList.add('is-on');
    move(event);
  }, { passive: true });

  document.addEventListener('pointerleave', () => glow.classList.remove('is-on'));
}

function initParallax() {
  const layers = $$('[data-parallax]');
  if (!layers.length || prefersReducedMotion()) return;

  const update = onFrame(() => {
    const y = window.scrollY;
    layers.forEach((layer) => {
      const speed = Number(layer.dataset.speed) || 0;
      layer.style.transform = `translate3d(0, ${(y * speed).toFixed(2)}px, 0)`;
    });
  });

  window.addEventListener('scroll', update, { passive: true });
  update();
}

function initTilt() {
  const nodes = $$('[data-tilt]');
  if (!nodes.length || prefersReducedMotion()) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;

  const MAX = 7;

  nodes.forEach((node) => {
    const move = onFrame((event) => {
      const rect = node.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      node.style.transform = `perspective(900px) rotateX(${(-py * MAX).toFixed(2)}deg) rotateY(${(px * MAX).toFixed(2)}deg) translateY(-4px)`;
    });

    node.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      move(event);
    });
    node.addEventListener('pointerleave', () => { node.style.transform = ''; });
  });
}

function initMarquee() {
  const track = $('[data-marquee]');
  const group = $('[data-marquee-group]');
  if (!track || !group) return;

  // Two identical halves keep translateX(-50%) seamless.
  const clone = group.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  track.append(clone);
}

export function initMotion() {
  initPreloader();
  initCursorGlow();
  initParallax();
  initTilt();
  initMarquee();
}
