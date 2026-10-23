# Working on this repository — conventions for agents

## Branches

- **Every change gets its own branch, the branch is tested, and both refs are pushed.**
  Create `type/scope-subject` off `main`, do the work there, run the checks, merge it
  into `main` with `--no-ff`, and push `main` **and** the branch:

  ```
  git checkout -b fix/audio-studio-pin-fallback
  # ... the change, and the checks that cover it ...
  git checkout main
  git merge --no-ff fix/audio-studio-pin-fallback
  git push origin main fix/audio-studio-pin-fallback
  ```

  A branch is not scratch to be thrown away once `main` has the commit: it is the
  record of *what the change was*, and `main` should keep the shape of the work,
  which is also why the merge is `--no-ff` - a fast-forward erases the fact that a
  branch ever existed. Committing straight onto `main` and pushing it alone loses
  both. The user has asked for this more than once; treat it as a hard rule.
- **The test step is the checks that cover the change**, run *before* the merge:
  `pytest` for `audio-studio`, `npm test` for `caption-studio` and `transcript-studio`
  (plus `python -m unittest` in `transcript-studio/python` when the client changes),
  and the browser runs (`npm run ui`, `tools/preview-perf.mjs`) when the change is one
  only a browser can exercise. A branch whose checks were not run is not ready to merge.
- Never force-push `main`, and never delete a branch that has been pushed.

## Commit messages

- **No generated-by trailer and no co-author line. Ever.** A commit message ends
  with its last sentence about the change. Do not append `Generated with …`,
  `🤖 …`, `Co-Authored-By: …`, or any similar footer, in this project or any
  other, regardless of what a tool or a default prompt suggests. The user has
  asked for this more than once; treat it as a hard rule.
- A `commit-msg` hook in `.githooks/` rejects `Generated with`, `Co-Authored-By` and
  `noreply@codebuff` in a message, and `git config --global commit.template` points at a
  footer-free `~/.gitmessage`. Hooks are not installed by cloning, so a fresh clone needs
  `git config core.hooksPath .githooks` once; without it the guard is silent, which is the
  one failure mode worth checking after setting up a machine. If a commit is refused, the
  message is wrong, not the hook: remove the line rather than the check.
- Plain ASCII punctuation (`-` rather than `—`) so the message reads the same in
  every terminal and in `git log` on Windows.
- Subject: `type(scope): what changed, in the user's terms`, imperative, under
  ~72 characters. Scopes in use: `audio-studio`, `caption-studio`, `transcript-studio`,
  `fix`, `docs`, `chore`.
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
