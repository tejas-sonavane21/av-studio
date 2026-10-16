# AQUALUX WATERSPORTS - demo site

Single page, scrollable marketing site for **Aqualux Watersports**, the jetcar
fleet at **Shreenika Coastal Retreat, Akshi Beach, Alibag**.

Node.js + HTML + CSS + vanilla JS (ES modules). No framework, no bundler, no
runtime dependencies - `node:http` serves the page and owns the booking API.

## Run it

```bash
cd demo_website
npm start           # http://localhost:4173
```

`PORT=8080 npm start` to move it, `npm run dev` to restart on file changes.

## Check it

```bash
npm test            # 10 server tests: routing, static files, validation, booking API
npm run check:browser   # headless Chrome: rendering, interactions, booking flow, responsive
```

The browser check drives Chrome over the DevTools protocol with Node's built-in
WebSocket, so it needs no npm packages. It fails on any console error from the
page, on stranded reveal elements, on a broken layout at 390px/900px/1440px, and
if the booking POST never reaches the store. Set `CHROME_PATH` if Chrome is not
in a standard location.

## What is here

```
demo_website/
  server.js                 static server + /api endpoints, catalog injection, booking store
  data/catalog.json         single source of truth: brand, jetcars, rides, packages, slots, FAQs
  data/bookings.json        runtime bookings (gitignored, created on first booking)
  public/index.html         the whole page
  public/styles/main.css    design system: beach palette, day + night themes, all components
  public/scripts/main.js    boots the modules
  public/scripts/modules/   catalog, selection store, nav, motion, reveal, rides, configurator,
                            pricing, gallery, reviews, faq, booking, icons, ui helpers
  public/assets/            favicon and social card art
  tools/browser-check.mjs   headless Chrome acceptance run
  tests/site.test.js        node:test suite for the server
```

### The catalog is the source of truth

`data/catalog.json` holds every price, ride, package, time window, FAQ and
contact detail. `server.js` injects it into `index.html` as an inline JSON block
on the way out, so the page is content complete on first paint and edits to the
catalog show up on reload without touching the HTML. If the block is empty (for
example when opening the file straight from disk) the page falls back to
`GET /api/catalog`, and if that fails too the sections explain that the site
needs `npm start`.

Prices appear **only** in `data/catalog.json`. The booking estimate shown
in the page and the total computed by `POST /api/bookings` both derive from it,
and both apply the same 18% GST line, so the browser and the server agree.

### API

| Method | Path             | Notes |
| ------ | ---------------- | ----- |
| GET    | `/api/health`    | liveness probe |
| GET    | `/api/catalog`   | the catalog JSON |
| POST   | `/api/bookings`  | validated request; price re-computed server side; returns `201` with a reference like `AQ-3F9K2M` |

The bookings collection is write-only on purpose: stored bookings hold guest
phone numbers, so there is no read endpoint. Requests are capped at 8 per IP per
10 minutes and the body at 32 KB. Bookings are appended to `data/bookings.json`
through a serialised queue with a temp-file rename, so two overlapping requests
cannot clobber each other.

## Interactions on the page

- Preloader, then a sticky header with scroll progress, active section tracking and a burger menu under 900px
- Day (shore) and night (deep water) themes, remembered in `localStorage`
- Hero: parallax sun, clouds and gulls, a bobbing inline SVG jetcar with animated spray and waves, floating stat cards, counters
- Jetcar configurator: pick one of three models and one of five finishes; the preview SVG repaints from CSS custom properties, specs, highlights and price follow, and reserving pushes the matching ride into the booking form
- Ride menu: category filter pills, cards that tick the matching checkbox in the booking form, capped at four rides per slot
- Gallery: draggable scroll strip with snap, arrow keys, and a lightbox with focus handling
- Ride windows, packages and the stats band are rendered from the catalog
- Reviews: autoplaying slider with dots, arrows and swipe, paused on hover or focus
- Booking form: live estimate with GST, client validation mirroring the server, success panel with a reference and a WhatsApp handoff
- FAQ accordion, back-to-top, transient toasts, and a full `prefers-reduced-motion` path

## Placeholders to replace before this goes live

1. **Contact details** in `data/catalog.json`: `phoneDisplay`, `phoneHref`, `whatsappNumber`, `email`, `instagramHandle`, `instagramUrl`. The current values are demo values.
2. **Prices and packages** - all figures in `data/catalog.json` are indicative.
3. **Photography** - the gallery tiles are CSS gradient art. To swap them for
   real photos, keep the `.gallery-card` wrapper and put an `<img>` inside the
   `.gallery-card__art` frame (see the comment in `index.html`).
4. **Map** - the embed points at a plain "Akshi Beach Alibag" query; replace it
   with the retreat's own Google Maps place link.
5. The verification note in the footer, once the site is real.

## Notes

- Line endings are CRLF in this repository; `git diff --ignore-cr-at-eol` shows real changes.
- The type face is Sora with Outfit for body text, loaded from Google Fonts with
  a system fallback stack, so the page still reads correctly offline.
