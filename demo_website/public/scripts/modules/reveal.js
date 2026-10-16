import { $$, plainNumber, prefersReducedMotion } from './ui.js';

function initReveals() {
  const nodes = $$('[data-reveal]');
  if (!nodes.length) return;

  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    nodes.forEach((node) => node.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const siblings = Array.from(entry.target.parentElement?.children || []);
      const order = Math.max(0, siblings.indexOf(entry.target));
      entry.target.style.transitionDelay = `${Math.min(order, 5) * 90}ms`;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

  nodes.forEach((node) => observer.observe(node));
}

function animateCounter(node) {
  const target = Number(node.dataset.counter);
  const decimals = Number(node.dataset.counterDecimals || 0);
  const suffix = node.dataset.counterSuffix || '';
  if (!Number.isFinite(target)) return;

  if (prefersReducedMotion()) {
    node.textContent = `${plainNumber(target, decimals)}${suffix}`;
    return;
  }

  const duration = 1500;
  const start = performance.now();

  const tick = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = `${plainNumber(target * eased, decimals)}${suffix}`;
    if (progress < 1) requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

function initCounters() {
  const nodes = $$('[data-counter]');
  if (!nodes.length) return;

  if (!('IntersectionObserver' in window)) {
    nodes.forEach(animateCounter);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      animateCounter(entry.target);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.4 });

  nodes.forEach((node) => observer.observe(node));
}

export function initReveal() {
  initReveals();
  initCounters();
}
