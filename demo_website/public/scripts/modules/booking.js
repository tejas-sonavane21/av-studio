import { $, $$, escapeHtml, formatDateLong, inr, toast } from './ui.js';
import { indexActivities } from './catalog.js';
import * as selection from './selection.js';

/**
 * The form mirrors server.js validation on purpose: the browser gives instant
 * feedback, the server stays the source of truth for prices and for what is
 * actually accepted. Both compute the same total, so a mismatch is a bug.
 */

const TAX_RATE = 0.18;
const UNIT_LABEL = { rider: 'per rider', boat: 'per boat', group: 'per group' };

const state = { catalog: null, activities: new Map(), sending: false };

const todayIso = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const riderCount = () => {
  const input = $('input[name="riders"]');
  const value = Number(input?.value);
  return Number.isInteger(value) && value > 0 ? value : 1;
};

function buildLines() {
  return selection.getSelection()
    .map((id) => state.activities.get(id))
    .filter(Boolean)
    .map((activity) => {
      const quantity = activity.unit === 'rider' ? riderCount() : 1;
      return { activity, quantity, amount: activity.price * quantity };
    });
}

function estimate(lines) {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

function renderQuote() {
  const lines = buildLines();
  const list = $('[data-quote-lines]');
  if (list) {
    list.innerHTML = lines.length
      ? lines.map((line) => `
          <li class="quote-line">
            <span>${escapeHtml(line.activity.name)} <em>${line.quantity > 1 ? `x${line.quantity}` : escapeHtml(UNIT_LABEL[line.activity.unit] || '')}</em></span>
            <strong>${inr(line.amount)}</strong>
          </li>
        `).join('')
      : '<li class="quote-lines__empty">No rides selected yet. Pick one from the menu above or below.</li>';
  }

  const { subtotal, tax, total } = estimate(lines);
  const subtotalNode = $('[data-quote-subtotal]');
  const taxNode = $('[data-quote-tax]');
  const totalNode = $('[data-quote-total]');
  if (subtotalNode) subtotalNode.textContent = inr(subtotal);
  if (taxNode) taxNode.textContent = inr(tax);
  if (totalNode) totalNode.textContent = inr(total);
}

function renderPicks() {
  const grid = $('[data-pick-grid]');
  if (!grid) return;

  grid.innerHTML = state.catalog.activities.map((activity) => `
    <label class="pick-option">
      <input type="checkbox" value="${escapeHtml(activity.id)}" data-pick>
      <span class="pick-option__text">
        <span class="pick-option__name">${escapeHtml(activity.name)}</span>
        <span class="pick-option__price">${inr(activity.price)} ${escapeHtml(UNIT_LABEL[activity.unit] || '')} &middot; ${escapeHtml(activity.duration)}</span>
      </span>
    </label>
  `).join('');

  grid.addEventListener('change', (event) => {
    const input = event.target.closest('[data-pick]');
    if (!input) return;
    if (input.checked) {
      const added = selection.toggle(input.value, true);
      if (!added) {
        input.checked = false;
        toast('Four rides is the most we can fit in one slot.');
      }
    } else {
      selection.toggle(input.value, false);
    }
  });
}

function syncPicks(ids) {
  $$('[data-pick]').forEach((input) => { input.checked = ids.includes(input.value); });
}

function renderSlots() {
  const select = $('[data-slot-select]');
  if (!select) return;

  select.innerHTML = [
    '<option value="">Choose a window</option>',
    ...state.catalog.slots.map((slot) => `
      <option value="${escapeHtml(slot.id)}" data-window="${escapeHtml(slot.window)}">
        ${escapeHtml(slot.name)} - ${escapeHtml(slot.window)}
      </option>
    `),
  ].join('');
}

function whatsappHref(extra = []) {
  const brand = state.catalog?.brand || {};
  const number = brand.whatsappNumber || '919820000000';
  const names = selection.getSelection()
    .map((id) => state.activities.get(id)?.name)
    .filter(Boolean);
  const message = [
    `Hi Aqualux, I would like to book a slot.`,
    ...names.map((name) => `- ${name}`),
    ...extra,
  ].join('\n');
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

/** Mirrors validateBooking() in server.js. */
function validate(data) {
  const errors = {};
  const name = data.name.trim();
  const phone = data.phone.replace(/\D/g, '');

  if (name.length < 2 || name.length > 80) errors.name = 'Enter the name the ride should be held under.';
  if (phone.length < 10 || phone.length > 15) errors.phone = 'Enter a phone number we can reach you on.';
  else if (phone.length === 10 && !/^[6-9]/.test(phone)) errors.phone = 'A 10 digit Indian mobile starts with 6, 7, 8 or 9.';
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) errors.email = 'That email address does not look right.';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) errors.date = 'Pick the date you want to ride.';
  else if (data.date < todayIso()) errors.date = 'That date has already passed.';

  if (!data.slot) errors.slot = 'Pick one of the three ride windows.';
  if (!Number.isInteger(data.riders) || data.riders < 1 || data.riders > 12) errors.riders = 'Riders must be between 1 and 12.';
  if (!data.activityIds.length) errors.activityIds = 'Choose at least one ride.';
  if (data.notes.length > 500) errors.notes = 'Keep the note under 500 characters.';

  data.activityIds.forEach((id) => {
    const activity = state.activities.get(id);
    if (!activity) {
      errors.activityIds = 'One of those rides is no longer available.';
      return;
    }
    if (Number.isInteger(data.riders)) {
      if (data.riders > activity.maxRiders) errors.riders = `${activity.name} takes at most ${activity.maxRiders} riders per booking.`;
      else if (data.riders < activity.minRiders) errors.riders = `${activity.name} needs at least ${activity.minRiders} riders.`;
    }
  });

  return errors;
}

function showErrors(errors) {
  $$('[data-error-for]').forEach((node) => { node.textContent = ''; });
  $$('.field, .fieldset').forEach((node) => node.classList.remove('has-error'));

  const summary = $('[data-form-error]');
  const entries = Object.entries(errors);

  if (!entries.length) {
    if (summary) {
      summary.hidden = true;
      summary.innerHTML = '';
    }
    return;
  }

  entries.forEach(([field, message]) => {
    const node = $(`[data-error-for="${field}"]`);
    if (!node) return;
    node.textContent = message;
    node.closest('.field, .fieldset')?.classList.add('has-error');
  });

  if (summary) {
    summary.hidden = false;
    summary.innerHTML = entries.length === 1
      ? escapeHtml(entries[0][1])
      : `<strong>Please check ${entries.length} things:</strong><ul>${entries.map(([, message]) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
  }

  const first = $(`[data-error-for="${entries[0][0]}"]`)?.closest('.field, .fieldset');
  first?.querySelector('input, select, textarea')?.focus();
}

function readForm(form) {
  const data = new FormData(form);
  return {
    name: String(data.get('name') || ''),
    phone: String(data.get('phone') || ''),
    email: String(data.get('email') || '').trim(),
    date: String(data.get('date') || ''),
    slot: String(data.get('slot') || ''),
    riders: Number(data.get('riders')),
    notes: String(data.get('notes') || '').trim(),
    activityIds: selection.getSelection(),
  };
}

function showSuccess(booking, quoted) {
  const form = $('[data-booking-form]');
  const success = $('[data-booking-success]');
  if (!form || !success) return;

  const slotName = state.catalog.slots.find((slot) => slot.id === booking.slot)?.name || booking.slot;
  const rideNames = booking.activities
    .map((id) => state.activities.get(id)?.name)
    .filter(Boolean)
    .join(', ');

  $('[data-success-ref]').textContent = booking.reference;
  const summary = $('[data-success-summary]');
  if (summary) {
    summary.textContent = `${booking.riders} rider${booking.riders > 1 ? 's' : ''} on ${formatDateLong(booking.date)}, ${slotName} window. ${rideNames}. Estimated total ${inr(quoted.total)} including GST.`;
  }

  const wa = $('[data-success-whatsapp]');
  if (wa) {
    wa.href = whatsappHref([
      `Name: ${booking.name}`,
      `Date: ${booking.date} (${slotName})`,
      `Riders: ${booking.riders}`,
      `Reference: ${booking.reference}`,
    ]);
  }

  form.hidden = true;
  success.hidden = false;
  success.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`Booking request sent. Reference ${booking.reference}.`);
}

async function submit(event) {
  event.preventDefault();
  if (state.sending) return;

  const form = event.currentTarget;
  const payload = readForm(form);
  const errors = validate(payload);
  showErrors(errors);
  if (Object.keys(errors).length) {
    toast('Please fix the highlighted fields.');
    return;
  }

  const button = $('[data-submit-button]');
  const original = button?.innerHTML;
  state.sending = true;
  form.classList.add('is-sending');
  if (button) button.textContent = 'Sending your request...';

  try {
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));

    if (response.ok && result.ok) {
      showSuccess(result.booking, result.estimate);
      return;
    }

    if (response.status === 400 && Array.isArray(result.errors)) {
      const mapped = {};
      result.errors.forEach((item) => { mapped[item.field] = item.message; });
      showErrors(mapped);
      toast('The booking desk rejected that request. Check the highlighted fields.');
      return;
    }

    if (response.status === 429) {
      showErrors({ form: result.errors?.[0]?.message || 'Too many booking requests. Try again shortly.' });
      return;
    }

    throw new Error(result.error || `Unexpected status ${response.status}`);
  } catch (error) {
    const summary = $('[data-form-error]');
    if (summary) {
      summary.hidden = false;
      summary.innerHTML = 'We could not reach the booking desk. Send the same details on WhatsApp and we will hold your slot.';
    }
    const wa = $('[data-whatsapp-link]');
    if (wa) {
      wa.href = whatsappHref([
        `Name: ${payload.name}`,
        `Date: ${payload.date}`,
        `Riders: ${payload.riders}`,
        `Phone: ${payload.phone}`,
      ]);
    }
    toast('Booking desk unreachable. Use the WhatsApp link.');
  } finally {
    state.sending = false;
    form.classList.remove('is-sending');
    if (button) button.innerHTML = original;
  }
}

export function initBooking(catalog) {
  const form = $('[data-booking-form]');
  if (!form || !catalog) return;

  state.catalog = catalog;
  state.activities = indexActivities(catalog);

  renderSlots();
  renderPicks();

  const date = form.querySelector('[name="date"]');
  if (date) {
    date.min = todayIso();
    date.value = date.value || todayIso();
  }

  $('[data-whatsapp-link]')?.setAttribute('href', whatsappHref());

  form.addEventListener('input', (event) => {
    if (event.target.closest('[data-error-for]')) return;
    renderQuote();
    const wa = $('[data-whatsapp-link]');
    if (wa) wa.href = whatsappHref();
  });
  form.addEventListener('change', renderQuote);
  form.addEventListener('submit', submit);

  selection.subscribe((ids) => {
    syncPicks(ids);
    renderQuote();
  });

  $('[data-booking-again]')?.addEventListener('click', () => {
    const success = $('[data-booking-success]');
    form.reset();
    selection.clear();
    showErrors({});
    if (success) success.hidden = true;
    form.hidden = false;
    const dateInput = form.querySelector('[name="date"]');
    if (dateInput) dateInput.value = todayIso();
    renderQuote();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  renderQuote();
}
