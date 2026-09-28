# assets / screenshots — reserved slot

dsh-market shows App Store-style screenshots on a plugin's detail page. A plugin declares
them **in its own repository**, in a `screenshots.json` next to `package.json`, listing
1–8 image paths relative to that file.

This directory is the reserved slot for those images; nothing is committed yet.

## To enable screenshots

1. Save the images here, using these names:

   | File | What it should show |
   |---|---|
   | `screenshot-1.png` | A 4–50 KB paste folded into a chip above the composer (the chip band, preview line, `在文本框中显示 ›`, `×`). |
   | `screenshot-2.png` | A ≥ 50 KB paste turned into an attachment, with the deliverable card in the turn tail. |

2. Copy the declaration into place:

   ```sh
   cp screenshots.json.example screenshots.json
   ```

3. Uncomment the two image lines in the `## Screenshots` section of [`README.md`](../README.md)
   (and of [`README.zh.md`](../README.zh.md) if you want them there too).

## Rules the market enforces

- 1–8 images.
- Relative paths only, and they may not leave the plugin directory: no leading `/`, no `..`.
- Absolute URLs are accepted as well, but must be **https on GitHub hosting**
  (`raw.githubusercontent.com`, `user-images.githubusercontent.com`, `camo.githubusercontent.com`,
  `github.com` attachments). Third-party image hosts are rejected for privacy reasons.
- **SVG is dropped** (logos/badges), so use PNG/JPEG/WebP.
- Prefer GitHub's own hosting. Renaming or deleting a file shows up immediately here; a
  hard-coded third-party URL rots silently.

Without `screenshots.json`, dsh-market falls back to extracting images from `README.md` —
the commented block in the `## Screenshots` section is exactly the markup it looks for, so
either route works.