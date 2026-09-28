# assets / screenshots

dsh-market shows App Store-style screenshots on a plugin's detail page and card. The plugin
declares them **in its own repository**, in [`screenshots.json`](../screenshots.json) next to
`package.json`, listing 1–8 paths relative to that file.

The two images here are real screenshots of the running plugin on DSH 0.1.7-rc.2:

| File | What it shows | Layer |
|---|---|---|
| `screenshot-1-fold-chip.webp` | A 4–50 KB JSON paste folded into a chip above the composer: preview line, `在文本框中显示 ›`, `×`. | Fold |
| `screenshot-2-spill-attachment.webp` | A ≥ 50 KB paste shown as a `pasted-text-173.json` (59 KB) attachment chip in the composer. | Spill |

## Replacing or adding a screenshot

1. Save the image here (PNG/JPEG/WebP — **SVG is dropped** as a logo/badge shape).
2. List it in [`screenshots.json`](../screenshots.json). Order is the carousel order; the
   first image is the card thumbnail. At most 8 entries.
3. Keep the alt text in the `## Screenshots` section of [`README.md`](../README.md) and
   [`README.zh.md`](../README.zh.md) pointing at the same file, so GitHub and the market
   fallback agree.

## Rules the market enforces

- 1–8 images.
- Relative paths only, and they may not leave the plugin directory: no leading `/`, no `..`.
- Absolute URLs are accepted as well, but must be **https on GitHub hosting**
  (`raw.githubusercontent.com`, `user-images.githubusercontent.com`, `camo.githubusercontent.com`,
  `github.com` attachments). Third-party image hosts are rejected for privacy reasons.
- Keep the file names stable: a relative path breaks visibly here, while a hard-coded
  third-party URL rots silently.

Without `screenshots.json`, dsh-market falls back to extracting images from `README.md`; the
`## Screenshots` section is written to work either way.