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
