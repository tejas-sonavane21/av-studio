# Third-party assets

The project's own code is MIT (see [`LICENSE`](LICENSE)). Everything on this page was written by
someone else, is bundled in the repository, and keeps its own terms — the MIT grant does not extend
to it.

This file exists because the two kinds of bundled asset have **different** licences, and one of them
is more restrictive than the project's own. If you are using this commercially, read the font row
before you ship.

## Vendored code

Third-party source is copied into the tree verbatim so the studio runs offline with no install step
and no build ([`caption-studio/vendor/VENDOR.md`](caption-studio/vendor/VENDOR.md) has the full story
and the project rule behind it: **zero runtime npm dependencies**).

| File | Package | Version | Licence | Source |
|---|---|---|---|---|
| `caption-studio/vendor/muxers/webm-muxer.mjs` | `webm-muxer` | 5.1.4 | MIT | <https://unpkg.com/webm-muxer@5.1.4/build/webm-muxer.mjs> |
| `caption-studio/vendor/muxers/mp4-muxer.mjs` | `mp4-muxer` | 5.2.2 | MIT | <https://unpkg.com/mp4-muxer@5.2.2/build/mp4-muxer.mjs> |
| `caption-studio/vendor/muxers/LICENSE` | both of the above | — | MIT, © 2022 Vanilagy | <https://unpkg.com/webm-muxer@5.1.4/LICENSE> |

Both are MIT, so they are compatible with this project's licence; their copyright notice is retained
alongside them, which is what the MIT terms require.

## Bundled fonts

Font binaries carry their own licences, and these three are **not** interchangeable. Two are in the
repository.

| File | Face | Licence | Commercial use |
|---|---|---|---|
| `caption-studio/src/fonts/packaged/HibernalSentry.ttf` (+ `.LICENSE.txt`) | Iconian Fonts' "Hibernal Sentry" (Daniel Zadorozny, 2024) | free for all non-commercial uses, redistribution permitted | **needs a licence** — <http://iconian.com/commercial.html> |
| `caption-studio/src/fonts/packaged/ZyenaHibernal.ttf` | CapCut's "Hibernal" — © Tianjin ZHUOMAN Technology Co., Ltd (`ZYENA`), 2021 | licensed to CapCut; **not ours to redistribute** | **not permitted** |

`caption-studio/src/fonts/packaged/README.md` records which faces are wired up, which may legally
ship, and why.

**About `ZyenaHibernal.ttf`:** this is the one bundled asset whose licence is narrower than "keep the
notice and you are fine", and it is committed deliberately rather than by oversight. The project is a
personal, local-first editor, and tracking the face is what makes a project render identically on every
machine its owner uses without a manual step after cloning. It is **not** a grant anyone else can rely
on: if you fork this, publish it, or use it commercially, remove that file (and the
`!ZyenaHibernal.ttf` line in `caption-studio/src/fonts/packaged/.gitignore`, or it will reappear) and
supply your own licensed copy. That is also the honest status of the file: including it makes the
repository's *own* licence statement weaker than MIT, and this paragraph is here so nothing about that
is implicit.

## Not in this repository

Deliberately absent, and documented rather than committed:

* **Google Fonts** (Inter and the other families in the picker) — fetched at runtime from Google's
  CDN, or supplied locally by dropping a `.woff2` into `caption-studio/src/fonts/packaged/`.
* **The rest of the "Hibernal Sentry" pack** (the other 20 Iconian styles: 3D, laser, gradient,
  condensed, …) — the download is local research material and stays gitignored; only the Regular face
  the picker actually offers is committed. See the packaged-fonts README for how to add another.
* **The reference material, the vendor dumps and the font pack** — local research data, gitignored;
  see [`.gitignore`](.gitignore).
