/**
 * AQUALUX WATERSPORTS - entry point.
 *
 * Order matters in one place: content is rendered from the catalog first, then
 * the reveal observer starts, so the cards and stat counters it watches exist
 * by the time it looks for them.
 */

import { loadCatalog, applyBrand } from './modules/catalog.js';
import { initMotion } from './modules/motion.js';
import { initNav } from './modules/nav.js';
import { initGallery } from './modules/gallery.js';
import { initConfigurator } from './modules/configurator.js';
import { initRides } from './modules/rides.js';
import { initPricing } from './modules/pricing.js';
import { initReviews } from './modules/reviews.js';
import { initFaq } from './modules/faq.js';
import { initBooking } from './modules/booking.js';
import { initReveal } from './modules/reveal.js';
import { toast } from './modules/ui.js';

async function boot() {
  initNav();
  initMotion();
  initGallery();

  let catalog = null;
  try {
    catalog = await loadCatalog();
  } catch (error) {
    console.warn('[aqualux] catalog load failed', error);
  }

  if (catalog) applyBrand(catalog.brand);

  initConfigurator(catalog);
  initRides(catalog);
  initPricing(catalog);
  initReviews(catalog);
  initFaq(catalog);
  initBooking(catalog);
  initReveal();

  if (!catalog) {
    toast('Ride data is offline. Start the site with "npm start" for live pricing.', 6000);
  }
}

boot().catch((error) => {
  console.error('[aqualux] boot failed', error);
  toast('Something went wrong loading the page. Refresh to try again.', 6000);
});
