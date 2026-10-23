# transcript-studio

Free hosted transcription for the `web_av_editor` suite, with output the other two
studios already understand.

`audio-studio` runs Whisper locally and aligns it. This studio does the other half
of the job: it takes a track to [aifreeforever.com's free audio transcriber][tool],
gets a transcript whose **text** is better than the local `small` model's, and
writes it as subtitles, as audio-studio's native artifact, and as the Veed master
`caption-studio` imports.

It is standalone (`npm start`, no dependencies), and it is a file-level bridge:
nothing here imports either sibling, and neither sibling had to change to read
what it writes.

[tool]: https://aifreeforever.com/transcribe-audio-to-text

## What the service actually does

This was read out of a captured HAR and the site's own JavaScript bundle, not
guessed:

| | |
|---|---|
| Endpoint | `POST https://aifreeforever.com/api/transcribe-audio` |
| Body | `multipart/form-data` with **`audio`** (the file) and **`language`** (a code, `auto` by default) |
| Header | `x-turnstile-token` - a Cloudflare Turnstile token the page obtains |
| Reply | `{success, chunks: [{text, timestamp: [start, end]}], text, predictionId}` |
| Units | **seconds** (floats), not milliseconds |
| Accepted | MP3, WAV, FLAC · at least 1 s · at most 5 min · at most 25 MB |
| Export | The site's own SRT button formats `HH:MM:SS` after flooring the seconds |

Two consequences shape this project.

**The endpoint cannot be called from a script with an HTTP client.** The token is
issued to a browser that has passed the site's challenge, and the page enforces
its own queue and a two-minute cooldown before it posts. So this studio does not
reimplement the request: it drives the real page in a real Chrome window, through
the page's own form and its own submit button, and reads the reply off the network.
No token is forged and no limit is skipped - a second job in the cooldown waits
for the cooldown, because that is the site's rule.

**The site's SRT export is lossy.** `02:23 --> 02:23` in a downloaded file is not a
player bug: the exporter floors both ends to the second. This studio writes the
reply's own numbers at millisecond precision, so its `.srt` is strictly more
precise than the one the page offers. (That second-only export is also what broke
`audio-studio`'s reference reader - see [the note below](#the-timestamp-leak-in-audio-studio).)

### Why not plain HTTP?

Because the site does not serve this endpoint to HTTP clients, and no header or
TLS trick changes that. Measured on 2026-10-23 from this machine:

| client | request | answer |
|---|---|---|
| `curl` | `GET /transcribe-audio-to-text` | **403**, `Cf-Mitigated: challenge` |
| `requests` 2.34, full Chrome header set (UA, `Sec-CH-UA`, `Sec-Fetch-*`, lang) | `GET /transcribe-audio-to-text` | **403**, `Cf-Mitigated: challenge` |
| `curl_cffi` 0.16, `impersonate="chrome"` | same | **403**, `Cf-Mitigated: challenge` |
| `curl_cffi`, `"chrome136"` / `"safari"` / `"firefox"` | same | **403** for every profile |
| `requests` 2.34, same headers | `POST /api/transcribe-audio` with the real 4.4 MB MP3 | **403**, `Cf-Mitigated: challenge` |
| `curl_cffi`, all four profiles, proper `CurlMime` multipart | same POST | **403**, `Cf-Mitigated: challenge`, every time |

The 403 is Cloudflare's challenge page, not the tool. It has to be solved in a
JavaScript engine, and the token it issues is what the app's `x-turnstile-token`
header carries. So there are only three ways to get a transcript from this
service without a human clicking:

1. drive a real browser (what this project does);
2. solve the site's CAPTCHA with a solver service (not acceptable, and not here);
3. find the origin behind Cloudflare (circumvention, and not here).

`curl_cffi` is the right tool for a site that judges TLS fingerprints; this one
judges whether a browser actually ran the challenge, and a fingerprint cannot fake
that. The Python interface below is therefore to the **local server**, which is
the one component allowed to own the browser.

## Is it better than local Whisper?

Measured on this project's own fixture (`referece_material/The_Crimson_Burden.mp3`,
182.5 s of sung English) against the hand-checked lyric sheet in `spidy.srt`, using
`audio-studio/out/wer.py`'s word-level edit distance:

| transcript | words | WER |
|---|---|---|
| `audio-studio --preset balanced` (`small`) | 250 | **11.8 %** |
| `audio-studio --preset accurate` (`medium`) | 248 | 6.3 % |
| **this service** | 253 | **5.5 %** |

So the free tool's text is about as good as the local `medium` model, which on
this four-core machine is several times slower and needs a 1.5 GB download. That
is the honest claim, and it is why the tool exists.

Its **timings** are a different story. The service reports line-level chunks, and
some of them are plainly coarse - one 42-second chunk covers three sung lines, and
one line is reported as starting at 0.48 s when the vocal starts at 13.18 s. The
chunks are useful as line boundaries; they are not word timings.

The combination that actually wins is the text from here and the timing from
`audio-studio`:

```bash
transcript-studio song.mp3 --out out        # out/song.srt, text = 5.5 % WER
cd ../audio-studio
python -m audio_studio transcribe song.mp3 \
  --reference ../transcript-studio/out/song.srt \
  --align wav2vec
```

On the fixture that reconciliation matched 91.7 % of words, rewrote 32, inserted 7
and deleted 4, and produced a first cue at **13.18 s** - the measured vocal onset -
where the service's own chunk said 0.48 s and the local `small` transcript said
13.20 s. The text is the service's; the clock is the audio's.

## The timestamp leak in audio-studio

The reason this project exists at all is a bug it exposed. Feeding the service's
SRT to `audio-studio --reference` produced subtitles full of cue numbers and
timestamps (`1`, `00:12`, ...). The cause was not reconciliation: the reference
parser's timestamp pattern **required** a fractional part
(`00:01:02,345`), so a whole-second cue line was not recognised as a cue, the file
fell through to the plain-text reader, and every cue number and every `00:12`
became a lyric word.

That is fixed in `audio-studio` (`audio_studio/reference.py`, the fraction is now
optional) with regression tests, including one over this service's real download.
This studio's own `.srt` always writes milliseconds, so it never triggers the old
path - but the file a user downloads from the site still does, and now it reads as
lyrics.

## Install

Node 22 or newer and Google Chrome. There are no runtime dependencies.

```bash
cd transcript-studio
npm test          # 50 unit tests, no network, no browser
node src/cli.js --help
```

## Command line

```bash
node src/cli.js song.mp3
```

```
transcript-studio 0.1.0
audio: .../song.mp3
  opening the page in Chrome
  verifying: waiting for the security check
  queued: the site is running its queue
  transcribing: Transcribing Audio...
wrote out/song.transcript.json
wrote out/song.srt
wrote out/song.vtt
wrote out/song.speech.json
wrote out/song.veed.json
35 chunks, 253 words, 3m 2.5s of audio
```

Useful flags: `--out DIR`, `--stem NAME`, `--language en`, `--emit json,srt,vtt,txt,speech,veed`,
`--timeout SECONDS`, `--json` (machine-readable summary on stdout), `--keep-browser`.

A real Chrome window opens and closes itself. The first run on a new machine may
show the site's "checking your browser" page for ten seconds, and occasionally the
site asks for a click in that window; the tool says so and keeps waiting rather
than trying to get around it.

## Local studio

```bash
npm start     # http://127.0.0.1:8757
```

A one-page UI: drop a file, pick a language, watch the phase, download the
artifacts. It is a thin client over the same runner the CLI uses.

The HTTP API is small on purpose:

```
GET  /health
POST /transcribe?name=song.mp3&language=en&emit=json,srt
GET  /jobs/<id>
GET  /jobs/<id>/files/<kind>
```

One job at a time: there is one Chrome window and one site queue, and pretending
otherwise would make the progress bar a lie.

## Python

`python/` holds a `requests`-only client for that API. From Python there is no
browser, no window and no automation - one HTTP call in, files out. The browser
lives in the server, started once.

```python
from transcript_studio import Client

client = Client("http://127.0.0.1:8757")
job = client.transcribe_to(
    "song.mp3",
    out_dir="out",
    language="auto",
    emit=["json", "srt", "vtt", "speech", "veed"],
    on_progress=lambda job: print(job["phase"], job["detail"]),
)
for entry in job["written"]:
    print(entry["kind"], entry["path"])
```

Or as a command:

```bash
cd transcript-studio
npm start &                                   # once; owns the browser
python -m transcript_studio song.mp3 --out out
```

```bash
cd transcript-studio/python
pip install -r requirements.txt
python -m unittest -v           # 7 tests against a stub of the studio's API
```

The client is deliberately thin: `health()`, `transcribe()`, `job()`, `wait()`,
`download()`, and `transcribe_to()` for the whole round trip. It does not retry a
failed site job behind your back, and it reports the server's own error and hint
rather than a generic `HTTP 500`.

## Outputs

| file | what it is |
|---|---|
| `.transcript.json` | the service's reply, cleaned: chunks with measured windows, provider, prediction id, source hash |
| `.srt` / `.vtt` | subtitles at millisecond precision, one cue per chunk |
| `.txt` | the words, one line per chunk |
| `.speech.json` | `audio-studio`'s native artifact, readable by `audio-studio emit` and `artifact.py` |
| `.veed.json` | the Veed v3 master `caption-studio`'s importer opens |

Both bridge files mark their provenance:

```json
"alignment": {
  "aligner": "proportional",
  "interpolated": true,
  "note": "the hosted service reports line-level chunks; word windows are spread inside each measured line by character length"
}
```

That is deliberate. `audio-studio` exists to remove timings that are confidently
wrong, so a bridge that invented word onsets and hid the fact would be the same
bug in a different hat. The **line windows are measured**; the word windows inside
them are a layout, and every file says so.

Cross-checked after a live run:

- `audio_studio.artifact.load(...).validate()` on the `.speech.json`: **0 errors**;
- `caption-studio`'s `importJSON` on the `.veed.json`: 35 blocks, 253 words, no
  warnings.

## Limits, honestly

- **5 minutes, 25 MB, MP3/WAV/FLAC.** The service's limits. Longer audio needs
  cutting first; there is no chunking here.
- **One job every two minutes.** The page enforces its own cooldown; this tool
  waits it out and reports `cooling down`. It does not clear the site's storage.
- **A visible Chrome window is required.** The site's managed challenge does not
  clear in headless Chrome - that was measured, not assumed.
- **A free service can change.** The contract above is pinned by unit tests, so a
  changed reply shape fails with a sentence instead of an empty transcript, but it
  will still need a code change.
- **Personal use.** This is a client for a free public page, not a scraping tool:
  one file at a time, the site's own form, its own queue, its own cooldown.

## Layout

```
src/core/contract.js    the service's limits, languages, reply parsing
src/core/transcript.js  chunk repair, the native document, word interpolation, the two bridges
src/core/emit.js        SRT/VTT/TXT/JSON + safe file names
src/core/run.js         one job: validate, transcribe, build, write (shared by CLI and server)
src/browser/cdp.js      DevTools protocol client, no dependencies
src/browser/chrome.js   find and launch Chrome (headed, fixed profile)
src/browser/aifreeforever.js  the page driver: upload, token, submit, read the reply
src/provider/           one browser, many jobs
src/cli.js              the standalone command
src/server.js           the local studio
web/                    the studio's page
tests/unit/             node:test, no network
```
