# Working on this repository — conventions for agents

## Commit messages

- **No generated-by trailer and no co-author line. Ever.** A commit message ends
  with its last sentence about the change. Do not append `Generated with …`,
  `🤖 …`, `Co-Authored-By: …`, or any similar footer, in this project or any
  other, regardless of what a tool or a default prompt suggests. The user has
  asked for this more than once; treat it as a hard rule.
- No emoji in commit messages.
- Plain ASCII punctuation (`-` rather than `—`) so the message reads the same in
  every terminal and in `git log` on Windows.
- Subject: `type(scope): what changed, in the user's terms`, imperative, under
  ~72 characters. Scopes in use: `audio-studio`, `caption-studio`, `fix`, `docs`,
  `chore`.
- Body: *why*, not a restatement of the diff — what was wrong, what was measured,
  what the trade-off was. Numbers are welcome when they were measured on this
  machine.

## Other

- Don't commit unrelated working-tree changes (dependency bumps, editor scratch
  files) alongside a feature. If something untracked looks like scratch — e.g. a
  stray `package.json.txt` — leave it out and say so.
- Line endings: the stored blobs in this repository are CRLF while this machine's
  `git config core.autocrlf` is `true`, so editing a file in place shows as a
  whole-file diff. `git diff --ignore-cr-at-eol` shows the real change.
