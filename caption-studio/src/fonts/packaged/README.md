# `fonts/packaged/` — locally supplied faces

The loader tries this directory **first**, before Google Fonts and before the OS, so a file dropped
in here is what makes a family render identically with no network at all (`fonts/loader.js`).
Filename → family mappings live in `../registry.js`.

A face here may be `.woff2` **or** `.ttf`/`.otf`: the loader hands the raw bytes to `FontFace`,
which sniffs the format, so no conversion step is needed.

## What is in version control, and what is not

Two display faces are wired up, and they are not equally distributable — which is the whole reason
this directory needs its own note:

| File | Committed? | Why |
|---|---|---|
| `HibernalSentry.ttf` | **yes**, with `HibernalSentry.LICENSE.txt` | Iconian Fonts: *"may be freely distributed and is free for all non-commercial uses"* |
| `ZyenaHibernal.ttf` | **no** | licensed to CapCut, not to us — see below |
| `Inter-900.woff2` | **no** | a download you already have; drop it in for offline parity |

Everything else in this directory is ignored by `.gitignore` (which allows only the two files above,
the README and itself). If a family is not yours to redistribute, nothing needs doing — that is
already the default.

## `HibernalSentry.ttf` — Iconian Fonts' "Hibernal Sentry"

* Iconian Fonts (Daniel Zadorozny), 2024, version 1.0.
* Source: <https://www.dafont.com/hibernal-sentry.font> (the download contains 21 styles; only the
  Regular face is wired up here).
* Licence: **free for all non-commercial uses, and redistribution is explicitly permitted** — the
  licence text travels with the binary as `HibernalSentry.LICENSE.txt`. **Commercial use needs a
  licence** from <http://iconian.com/commercial.html>.
* Unrelated to CapCut's Hibernal despite the shared word — this one is a techno/sci-fi display face.

## `ZyenaHibernal.ttf` — the face CapCut calls "Hibernal"

* Foundry: Tianjin ZHUOMAN Technology Co., Ltd (`ZYENA`), version 1.00, December 2021.
* CapCut identifies it as `fontId 7044916245971341825`, `fontFamily "ZyenaHibernal"`, Regular.
* **Do not commit this file and do not redistribute it.** It is licensed to CapCut; it is copied
  here so this editor can render the same look locally, nothing more.

CapCut downloads a font the first time a project uses it, then keeps it in its local cache. To copy
it out on Windows 11, find the cached resource under the user's CapCut data and copy the `.ttf`:

```bash
# CapCut caches one directory per font, named by fontId; the file inside is the font itself.
find "$LOCALAPPDATA/CapCut/User Data/Cache/effect" -iname "*hibernal*.ttf"
# → .../Cache/effect/7044916245971341825/<hash>/ZYENA Hibernal.ttf

cp ".../ZYENA Hibernal.ttf" caption-studio/src/fonts/packaged/ZyenaHibernal.ttf
```

Open the project in CapCut and set the caption font to **Hibernal** once if the cache is empty —
that is what makes CapCut download it. The directory name is the `fontId` and the inner hash is the
resource version, so grep for the name rather than hard-coding either.

## Adding another face

1. Drop the file in here.
2. Add an entry to `FONT_REGISTRY` in `../registry.js` with `packaged: { <weight>: '<filename>' }`,
   a `weights` list containing that weight, and a `stack` that starts with the family name and ends
   in a generic family (`cursive` or `sans-serif`).
3. If the family is not yours to redistribute, confirm it is ignored by git — everything here but
   the files named above already is. If it *is* yours to redistribute, add a `!<filename>` line to
   `.gitignore` and commit the licence text next to the binary.
