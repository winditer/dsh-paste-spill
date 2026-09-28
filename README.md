# dsh-paste-spill

English | [中文](README.zh.md)

Inbound large-paste handling for the DeepSeek Harness composer: a **4–50 KB** paste folds into **one chip per paste** (expand or delete it on its own), and a **≥ 50 KB** paste becomes a **real file attachment** with a deliverable card in the turn tail.

`dsh-spill` covers the outbound direction — tool output leaving the model. This plugin covers the opposite half: a large log, diff, JSON dump or document pasted **into** the input box.

| Layer | Pasted size (UTF-8 bytes) | What happens |
|---|---|---|
| Fold | 4,000 – 50,000 | That pasted run leaves the editor and becomes one chip. One chip per paste — several coexist, and earlier chips are never overwritten. |
| Spill | ≥ 50,000 | The text is uploaded as a real attachment: the message carries a `file` block and the turn tail gets a clickable card that opens the file in the right sidebar. |

The two layers are independent and both measure the **pasted text**, not the draft: the fold layer changes what the composer looks like, the spill layer changes what the model receives. Pastes under 4,000 bytes are left entirely alone.

## The fold layer (4,000 – 50,000 bytes)

Pasting 4 KB–50 KB in one go moves **just that pasted run** out of the editor and into a chip held by the plugin. Text you typed, and chips from earlier pastes, are untouched.

Each chip shows:

- the first 20 characters of its paste (whitespace flattened) as a preview line;
- `在文本框中显示 ›` / `Show in text box ›` — click to write **that chip's** full text back into its position and release it;
- `×` — delete **just that chip** and release its text (`删除这段文本` / `Delete this text`).

The chip is a real editor node rather than a decoration, and it registers an `inputTriggers` source whose `serialize(ref)` returns the **full original text**. Sending therefore posts the paste itself — not a placeholder, and not an attachment.

Because one paste equals one chip, pasting a second 6 KB block **appends** a chip instead of replacing the first one: a chip is the only carrier of its text, so overwriting one would silently delete that paste.

The floating chip band measures itself and publishes its height as `--dshps-chip-band` on the composer card, which the card turns into `padding-top`. The chips sit above the first line of input instead of covering it, and reflow when several chips wrap onto a second line.

## The spill layer (≥ 50,000 bytes)

A paste of 50,000 bytes or more is turned into a `File` and sent through the composer's existing attachment upload path, with a content-sniffed name (`pasted-text-<n>.json` / `.md` / `.py` / `.js` / `.html` / `.csv` / `.txt`). The result is a legal `file` block in the message, so the model receives a read-only host path through the stock attachment handling — no session format change and no model-side change.

The host half watches `agent/inbox/inserted` for those paste files, resolves each one's host path from the attachment store, and publishes a `deliverables/presented` event on `agent/pre-step`, which the stock deliverables UI renders as a clickable card in the turn tail. Clicking the card opens the file in the right sidebar. The original text is then excised from the composer **in place** — the pasted run's own span is overwritten with `""`, never the whole draft, so other chips, typed text, the caret and undo history all survive.

## Screenshots

**The fold layer** — a 4–50 KB paste becomes one chip: preview line, `在文本框中显示 ›` to write it back, `×` to delete just that paste.

![dsh-paste-spill plugin preview 1: a JSON paste folded into a chip reading { "readings": { "bac… above the DeepSeek Harness composer, with the expand affordance and the delete button](assets/screenshot-1-fold-chip.webp)

**The spill layer** — a ≥ 50 KB paste becomes a real attachment (`pasted-text-173.json`, 59 KB) in the composer, so the model gets a file instead of a wall of text.

![dsh-paste-spill plugin preview 2: a 59 KB JSON paste shown as a pasted-text-173.json attachment chip in the composer, with the send button active](assets/screenshot-2-spill-attachment.webp)

dsh-market shows these on the plugin card and in the detail view; they are declared in [`screenshots.json`](screenshots.json) so their order and selection are curated here rather than guessed from this README.

## Install

From the DeepSeek Harness CLI, into the **web** profile — published on npm as [`dsh-paste-spill`](https://www.npmjs.com/package/dsh-paste-spill):

```sh
dsh plugin --profile web add dsh-paste-spill
```

Prefer the source? The same package installs straight from GitHub:

```sh
dsh plugin --profile web add github:winditer/dsh-paste-spill
```

On **DSH Desktop**, install it from the in-app plugin manager (Settings → Plugins) or through the plugin market; the CLI refuses `--profile desktop` because that profile is owned by the application.

Working on the plugin from a local checkout? `scripts/install-into-profile.sh` links this repository into the desktop profile and adds the dependency entry that keeps the bundle row from being erased by profile reconciliation.

After install, the browser half is a page-level module: **refresh the page** (or relaunch) to pick it up.

## Compatibility

- Declared in `package.json` as `engines.dsh: ">=0.1.7-rc.2 <0.2.0-0"`, so dsh-market can state the requirement on the plugin card. Verified on DSH **0.1.7-rc.2** (web and desktop).
- Web UI only (`dsh.client.platform: "web"`): the fold chip, the chip band and the attachment upload all live in the browser half. The host half runs anywhere the bundle loader does.
- No stock package is patched or replaced. The plugin uses public extension points only: an `inputTriggers` source, the `conversation.input.overlay` slot, the existing attachment upload, and the `agent/inbox/inserted` / `agent/pre-step` session events.

## How it works

```
package dsh-paste-spill — one loader row, two halves
  browser half  lib/client.js     (dsh.client, platform: web)
    draft watcher + paste events
      4000-50000 → register a chip source, replace the pasted run with a chip node,
                   hold the text by ref, render the chip band in the composer overlay
      >= 50000   → synthesize a File and ride the stock attachment upload
  host half     lib/index.js      (exports["."], dsh.bundle.patch)
    agent/inbox/inserted → record the paste attachment's host path
    agent/pre-step       → session.append("deliverables/presented", ...)
                           → stock deliverables card → right-sidebar preview
```

One package, one row: `cordis.patch.yml` declares `dsh-paste-spill` once, and the loader imports the host half through `exports["."]` while the web-modules scanner discovers the browser half from `dsh.client` plus `exports["./client"]` in the same `package.json`.

## Development

```sh
node --test            # 108 tests: host half 17 (helpers 7 + plugin 10), browser half 91
```

- The plugin package **is** the repository root, which is what the market's `dsh.bundle` check reads.
- [docs/internals.md](docs/internals.md) — the implementation log: the real-device bugs behind the current design, the adversarial review findings, and the debugging paths that were tried and rejected.
- [docs/superpowers/specs/](docs/superpowers/specs/) and [docs/superpowers/plans/](docs/superpowers/plans/) — design document and implementation plan.
- [fixtures/](fixtures/) — real paste payloads (3 KB / 6 KB / 60 KB) used by the tests.
- [scripts/read-leveldb.py](scripts/read-leveldb.py) and [scripts/read-session.mjs](scripts/read-session.mjs) — evidence tools for reading renderer Local Storage and what a session actually submitted, used when no console is available.
- In-app diagnostics are written to `localStorage["dsh.paste-spill.diag"]` (`bySession.<sessionId>` for the per-session facts). `build` must equal the current `BUILD_REV` and `applyRanAt` must be fresh if a new build is really loaded.
- Releasing: bump `version` in `package.json`, then `pnpm publish`. The `files` list keeps the tarball to `lib`, `cordis.patch.yml`, both READMEs, `screenshots.json`, `assets` and `LICENSE`; there is no build step, so a published version is exactly the source.

## Known limitations

- Chips are per session. Switching away while a paste is folded and coming back restores the original text into the input box (the plugin no longer draws a chip for it), so the text is never lost and the chip's label is never sent in its place.
- A chip insert is a revision CAS on the draft: when the revision moved, the insert is retried and, if it is still refused, the fold record is rolled back — the text stays in the input box and no chip is drawn for it.
- Spilled pastes are excised from the composer only when the pasted run can still be located. When it cannot, the text is left in place next to the attachment (harmless, and recoverable) rather than clearing the draft.
- If the attachment upload fails, the text is written back into the editor best-effort; the failed attachment card keeps its retry control.
- The chip label itself (`已折叠 5.9 KB`) is currently Chinese; the chip tooltip and the expand affordance are localized (zh / en).

## License

[MIT](LICENSE)