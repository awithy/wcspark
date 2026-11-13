# Sparks

A single-user, chronological journal of interesting things: links, ideas, screenshots, and text blurbs.

- Newest-first feed grouped by day; loads 200 sparks at a time with infinite scroll.
- Free-text search (SQLite FTS5, trigram tokenizer: substring and case-insensitive matching;
  `"quoted phrases"`; all terms must match).
- Paste images into the composer, or press Ctrl+V anywhere on the page. You can also drag-and-drop or pick files.
- Keyboard-driven: `j`/`k` to move, `/` to search, `n` to write, `e`/`d`/`y`/`o` to edit, delete, copy, or open
  the selected spark. Press `?` for the full list.
- Follows the system light/dark preference, or pin light or dark per device with the toggle in the top bar (`t`).
- Installable PWA with an Android share target: share a link or image from any app into Sparks.
- No auth. It is meant to sit behind a reverse proxy that handles mTLS.

## Running

```sh
npm install
npm run dev        # API on :3000 + Vite on :5173 (proxied)
npm run build
npm start          # serves API + built client on HOST:PORT
npm test           # API tests (vitest)
npm run typecheck
```

Requires Node 22+.

| Env var    | Default     | Notes                                      |
| ---------- | ----------- | ------------------------------------------ |
| `HOST`     | `127.0.0.1` | Bind address                               |
| `PORT`     | `3000`      |                                            |
| `DATA_DIR` | `./data`    | Database, original images, and thumbnails  |

## CLI

`wcspark` talks to the API over HTTPS with an mTLS client certificate.

```sh
npm run cli:install          # bundles to dist/cli/wcspark.js, installs to ~/.local/bin/wcspark
npm run cli -- ls            # run from source (tsx) without installing
```

Configure it in `~/.config/wcspark/config.json` (or `WCSPARK_URL`/`_CERT`/`_KEY`/`_CA` env vars,
or `--url`/`--cert`/`--key`/`--ca` flags, which take precedence in that order):

```json
{ "url": "https://sparks.example.com", "cert": "~/keys/client.cert.pem", "key": "~/keys/client.key.pem" }
```

`ca` is only needed when the server's certificate isn't publicly trusted. `wcspark config --check`
shows the effective settings and tests the connection.

```sh
wcspark add Look into smithy.io for API codegen
wcspark add "https://example.com/post?id=1" -i shot.png other.jpg
wcspark add -c                         # clipboard image or text (wl-paste / xclip)
pbpaste | wcspark add                  # stdin; with no input at all, $EDITOR opens
wcspark ls --since 7d                  # also --until, --on <day>, -n, --all, -l, --json
wcspark search aws emulator
wcspark show 12
wcspark edit 12 -a "follow-up"         # or replacement text, -i, -c, -r <n|image-id>, --clear-images, -e
wcspark rm 12 -y
wcspark dl 12 -o ~/Downloads           # images by spark id or image id; --thumb, -o -
wcspark export ~/backup/sparks         # sparks.json + images/ (incremental)
wcspark open aws                       # web app in the browser
```

Every listing and editing command accepts `--json`; image objects there include an absolute `url`.

An agent skill for pi lives in `skills/wcspark/SKILL.md`; `npm run skill:install` copies it to `~/.pi/skills/`.

## Data

```
DATA_DIR/
  sparks.db        SQLite (WAL mode)
  images/<id>.<ext> originals, stored byte-for-byte as uploaded
  thumbs/<id>.webp  ≤840px thumbnails used in the feed
```

**Backup:** `sqlite3 data/sparks.db ".backup backup.db"` plus a copy of `images/`.
Thumbnails can be regenerated from the originals, but backing them up as well is simpler.

Images are uploaded as soon as they're pasted. Uploads that never get attached to a saved
spark are removed after 24 hours.

## Sharing from your phone

Open the app in Chrome on Android and choose *Install app* / *Add to Home screen*. Sparks
then appears in the system share sheet. Shared text, URLs, and images open in the composer
for review before saving. iOS Safari doesn't support Web Share Target, so on iOS use
copy and paste instead.

## Layout

```
src/server   Fastify API, SQLite (better-sqlite3), image processing (sharp)
src/client   React UI (Vite)
src/cli      wcspark command-line client (commander, bundled with esbuild)
src/shared   Types and helpers used by both
public/      PWA manifest, service worker, icons (regenerate with `npm run icons`)
```
