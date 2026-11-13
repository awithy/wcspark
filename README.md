# Sparks

A single-user, chronological journal of interesting things: links, ideas, screenshots, and text blurbs.

- Newest-first feed grouped by day; loads 200 sparks at a time with infinite scroll.
- Free-text search (SQLite FTS5, trigram tokenizer: substring and case-insensitive matching;
  `"quoted phrases"`; all terms must match).
- Paste images into the composer, or press Ctrl+V anywhere on the page. You can also drag-and-drop or pick files.
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
src/shared   Types and helpers used by both
public/      PWA manifest, service worker, icons (regenerate with `npm run icons`)
```
