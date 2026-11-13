---
name: wcspark
description: Read and write the user's Sparks journal (wcspark.ft.withy.io) with the wcspark CLI — add links, ideas, notes, and screenshots; list, search, show, edit, and delete sparks; filter by date; download images; export. Use when asked to save something to Sparks or the journal, or to find something the user saved there; not for todos (wctodo) or issue trackers.
compatibility: Requires the wcspark executable (installed at ~/.local/bin/wcspark) and its configured mTLS client certificate.
---

# wcspark CLI

Sparks is the user's chronological journal of interesting things: each spark is a text blurb (often containing a URL) and/or up to 20 images. Use `wcspark` through the shell; it talks to the API. Never touch the server's SQLite database or data directory. Use `wcspark <command> --help` for exact flags rather than inventing them.

## Connection

`~/.config/wcspark/config.json` already points at `https://wcspark.ft.withy.io` with an mTLS client certificate and key, so ordinary commands need no flags or exports. This is the user's **real journal**, not a test instance; don't add test sparks to it.

- Precedence: flags (`--url`, `--cert`, `--key`, `--ca`, given before the command), then `WCSPARK_URL`/`WCSPARK_CERT`/`WCSPARK_KEY`/`WCSPARK_CA`, then the config file (`$WCSPARK_CONFIG` overrides its path).
- `wcspark config` shows the effective settings without contacting the server; `wcspark config --check` also tests the connection. Don't print the private key or copy certificate material anywhere.
- If the server can't be reached or rejects the certificate, report the error. Don't change the config, start servers, or bypass TLS to work around it.
- The source is `/home/adrian/projects/wcspark` (`src/cli`). After CLI changes, run `npm test` and reinstall with `npm run cli:install` there. For development, run a local server with `npm run dev` and use `WCSPARK_URL=http://127.0.0.1:3000 npm run cli -- <command>` so nothing goes to production.

## Reading

```sh
wcspark ls --json                    # newest 20
wcspark ls -n 100 --json
wcspark ls --all --json              # everything
wcspark ls --since 7d --all --json   # last week
wcspark ls --on yesterday --json     # one day; also today, weekday names, YYYY-MM-DD
wcspark ls --since 2026-11-01 --until 2026-11-10 --all --json
wcspark search aws emulator --json   # every term must match
wcspark search '"exact phrase"' --json
wcspark show 12 --json               # several ids give an array
```

- Prefer `--json` and filter with `jq`, e.g. `wcspark ls --all --json | jq -r '.[] | "\(.id)\t\(.blurb // "" | split("\n")[0])"'`.
- `ls` and `search` default to the newest **20**. Use `-n` or `--all` when you need more. The "Showing the newest N" hint goes to stderr, and stdout stays valid JSON.
- Search is case-insensitive substring matching on the blurb text (not images). All terms must match (AND). There is no OR, so run separate searches and merge the results. Quote a phrase *inside* the argument: `'"two words"'`.
- Time filters: `--since`/`--until` take `today`, `yesterday`, weekday names (the most recent one, today included), `YYYY-MM-DD`, `"YYYY-MM-DD HH:mm"`, ages like `30m`/`12h`/`7d`/`2w`, or ISO timestamps. A date passed to `--until` includes that whole day. Local time zone. For anything else, work out the date yourself.
- JSON fields: `id`, `blurb` (string or `null` for image-only sparks), `createdAt`/`updatedAt` (Unix epoch **milliseconds**), `images[]` with `id`, `mime`, `width`, `height`, `url`. Convert timestamps to local time when presenting them.
- Results are newest first. Refer to sparks by `#id` and the first line of the blurb.

### Looking at images

Images can't be viewed through their URLs, which need the client certificate. Download them first, then read the files:

```sh
wcspark dl 12 -o /tmp/wcspark-12/            # all images of spark 12; prints the saved paths
wcspark dl vTL1Eh1R33MRRhYB -o /tmp/shot.png # one image by image id
wcspark dl 12 --thumb -o /tmp/wcspark-12/    # ≤840px WebP thumbnails (smaller)
```

## Adding

```sh
wcspark add 'Look into smithy.io for API codegen' --json
wcspark add 'https://example.com/post?id=1&x=2 — good overview of X' --json
wcspark add 'Whiteboard from the planning session' -i /tmp/board.jpg /tmp/notes.png --json
wcspark add -i /tmp/screenshot.png --json           # image-only spark
wcspark add - --json <<'EOF'
Multi-line spark.
Second line, with "quotes" and $dollars kept literally.
EOF
```

- Single-quote the text. URLs contain `?`, `&` and `#`, which the shell would otherwise mangle. Words are joined with single spaces, so use the `-` + quoted heredoc form for multi-line text or text containing single quotes.
- `-i` takes every following argument as an image file, so put the text **before** `-i`. If the text starts with `-`, use `--` before it: `wcspark add -- '-5 degrees tonight'`.
- Save what the user gave you. Don't summarise, rewrite, or add commentary unless asked. When they share a link with a note, put the URL and the note together in one spark.
- Limits: 4000 characters of text, 20 images, 25 MB per image; PNG, JPEG, WebP, GIF, or AVIF (convert others first, e.g. HEIC). The CLI checks these before uploading.
- Don't use `-c`/`--clipboard` or a bare `wcspark add` (which opens `$EDITOR` in a terminal). Those are for the user's own interactive use, and the agent shell has no clipboard or terminal. A bare `wcspark add` here fails with "Nothing to add".
- `add` prints the new spark. Report its id.

## Editing

```sh
wcspark edit 12 -a 'Follow-up: they open-sourced it' --json  # append a line
wcspark edit 12 'Completely new text' --json                 # replace the whole text
wcspark edit 12 - --json <<'EOF'
Replacement text from stdin.
EOF
wcspark edit 12 -i /tmp/extra.png --json     # add images (appended after the existing ones)
wcspark edit 12 -r 2 --json                  # remove the 2nd image (numbers as in `show`), or -r <image-id>
wcspark edit 12 --clear-images --json
wcspark edit 12 '' --json                    # clear the text (only if it has images)
```

- `edit` applies only the changes given. Images are kept unless `-r` or `--clear-images` is used, and the text is kept unless replacement text is given.
- Replacement text replaces the **whole** blurb. For partial changes ("fix the typo", "change the link"), run `wcspark show <id> --json` first, build the full new text, and pass it via `-` and a heredoc.
- Removed images are deleted from the server for good.
- `-e`/`--editor` needs a terminal; don't use it.

## Deleting and other commands

```sh
wcspark rm 12 -y              # several ids allowed
wcspark export ~/backup/sparks   # sparks.json + images/, only downloads new images
```

- Deletion is permanent and removes the spark's images. Only delete when the user has asked to delete those specific sparks, and confirm first if a description could match more than one (search, then show the candidates). The agent shell isn't a terminal, so `rm` refuses to run without `-y`.
- `wcspark open [query]` opens the web app in the user's browser. Only use it when asked.
- On failure the CLI prints `wcspark: <message>` to stderr and exits 1. With several ids, `rm` handles each one and reports failures separately.
