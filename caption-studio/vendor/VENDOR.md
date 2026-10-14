# Vendored files

Everything here is third-party code copied into the tree verbatim, so the studio runs offline with
no install step and no build. Each entry names its version, licence and source URL.

The project's own rule (IMPLEMENTATION-PLAN §3.3) is **zero runtime npm dependencies**: anything
needed is vendored here rather than pulled from a registry at run time.

---

## `muxers/` — WebM and MP4 container writers

Our export encodes frames with the browser's **WebCodecs** API (`VideoEncoder` /`AudioEncoder`),
which produces *encoded chunks* but no file. These two libraries write those chunks into a real
container. They are pure ESM, have no dependencies of their own, and only ever touch the bytes they
are handed — no network, no DOM.

| File | Package | Version | Licence | Source |
|---|---|---|---|---|
| `muxers/webm-muxer.mjs` | `webm-muxer` | 5.1.4 | MIT | https://unpkg.com/webm-muxer@5.1.4/build/webm-muxer.mjs |
| `muxers/mp4-muxer.mjs` | `mp4-muxer` | 5.2.2 | MIT | https://unpkg.com/mp4-muxer@5.2.2/build/mp4-muxer.mjs |
| `muxers/LICENSE` | both | — | MIT | https://unpkg.com/webm-muxer@5.1.4/LICENSE |

Both are by the same author (Vanilagy / Vanilagy), under the same MIT licence, reproduced in
`muxers/LICENSE`.

**Why these and not an `.mp4` written by hand:** an MP4 is a container of many nested boxes
(`moov`/`trak`/`stsd`/`avcC`…), and every byte offset in the sample tables has to be right or the
file is simply unplayable. That is not a place to be clever. The WebM/Matroska case is friendlier,
but the same argument applies once Opus and VP9 seek metadata are involved.

**Codec coverage used here**

- WebM: video `V_VP9` / `V_VP8`, audio `A_OPUS`.
- MP4: video `avc` (H.264), audio `aac` — with `opus` supported by the muxer but not used, because
  Opus in MP4 plays in very few players.

Verified at runtime with `VideoEncoder.isConfigSupported()` / `AudioEncoder.isConfigSupported()`
before anything is constructed (see `src/io/webcodecs-export.js`).

---

## `mediabunny/` - reading, decoding, re-encoding and writing media files

`src/io/preview-proxy.js` makes the preview's smaller copy with this library, and that is a
measurement rather than a preference. The version it replaced played the picture through a hidden
`<video>` and encoded the frames it presented - and a `<video>` presents frames on the wall clock, so a
4K file whose decoder manages 16 frames a second offered 16 frames a second and the copy came out
as choppy as the original. Mediabunny drives the decoder itself (`VideoDecoder`, off any clock,
hardware-accelerated where the machine has it), so the copy holds the file's real motion, and it does
it in one pass that takes as long as decoding takes instead of as long as the clip runs.

| File | Package | Version | Licence | Source |
|---|---|---|---|---|
| `mediabunny/mediabunny.min.mjs` | `mediabunny` | 1.61.4 | MPL-2.0 | https://unpkg.com/mediabunny@1.61.4/dist/bundles/mediabunny.min.mjs |

Two callers now: `src/io/preview-proxy.js` (which converts, and writes a copy) and
`src/io/webcodecs-export.js` (which only reads frames - the export keeps its own encoder and muxer).
| `mediabunny/LICENSE` | - | - | MPL-2.0 | https://github.com/Vanilagy/mediabunny/blob/main/LICENSE |

The bundle is the published one, byte for byte: sha256 `y8ddp0nWhHibLs2Iv8z1UHavHtPGZeFjHbFc+Mh2V0I=`
(base64, the form the npm registry reports), 691,470 bytes. `git ls-files --eol` shows it as `attr/-text`
because `.gitattributes` turns line-ending conversion off for it - a carriage return inserted inside one
of a minified file's string literals is a different program, and `core.autocrlf=true` would otherwise
give a Windows clone different bytes from a Linux one.

**Why a whole media toolkit and not a few more lines of our own:** resizing a video means demuxing a
container, configuring and driving a `VideoDecoder`, converting and reviewing frames, configuring and
driving a `VideoEncoder` with the right codec string for the environment, and muxing the result with
timestamps that match the source - and getting any one of those wrong produces a file that looks fine
until it is played. Every one of those steps is a place this project already measured a bug: the
wall-clock capture above, a `MediaRecorder` that dropped frames under load, a stereo/mono mismatch that
silently lost a soundtrack. Mediabunny is the muxers above grown into a complete toolkit by the same
author (Vanilagy, who wrote `mp4-muxer` and `webm-muxer` and now recommends this instead of them), and
it is what the *preview copy* uses.

**The export uses it to read, and not to write.** `src/io/webcodecs-export.js` now decodes its picture
through this library too (`openPictureStream()`), which is a measurement rather than a preference: the
export used to seek a `<video>` once per output frame, and on this project's 2160p AV1 capture that was
**1448 ms a frame and 98.5% of the whole export** - a seek on a paused element is a decoder flush plus a
decode from the previous keyframe, paid again for every frame. Reading through Mediabunny decodes the
range in order, off any clock, and took the same window from 264.6 s to 19.0-19.6 s (`tools/export-perf.mjs`).
Overlay clips are read the same way, for the same reason.

What the export does **not** hand over is the writing. It still drives `VideoEncoder`/`AudioEncoder` and
the muxers above directly, because the export has requirements a general-purpose converter does not meet:
the caption canvas is composited into every frame (clips, logos, cut boundaries), the resolution and
bitrate come from the export window's own ladder, and the file has to be written at the user's chosen
container and quality. A preview copy has none of that - it is the same picture, smaller - and that is
exactly the kind of job a library should own.

**MPL-2.0, not MIT like the rest of this directory.** MPL-2.0 is *file-level* copyleft: it applies to
the file it came in (`mediabunny.min.mjs`) and not to the project that includes it, so an MIT project
may ship it. The obligations are met by keeping the licence text beside the file and by vendoring it
**verbatim** - unmodified, exactly as `unpkg` serves it - because a modified MPL file would have to be
published as source in turn. The full text is `mediabunny/LICENSE`; nothing here is derived from it.

**Unminified alternative:** `dist/bundles/mediabunny.mjs` (1.4 MB) and `dist/modules/` are what the
package's own `module` field points at. The minified bundle is one file, imports nothing, and is what
is checked in here.
