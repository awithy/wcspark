import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { MAX_BLURB_LENGTH, MAX_IMAGES_PER_SPARK, type Spark } from "../shared/types.js";
import { createClient, EXT_BY_MIME, type Client } from "./client.js";
import { loadConfig, type CliConfig } from "./config.js";
import { dim, printJson, sparkBlock, sparkJson, sparkLine } from "./format.js";
import { editText, readClipboard, readImageFile, readStdin, stdinIsTTY, type ImageFile } from "./input.js";
import { parseDay, parseWhen } from "./when.js";

const IMAGE_ID_RE = /^[A-Za-z0-9_-]{16}$/;

// ---- helpers -------------------------------------------------------------------

let client: Client | undefined;
function connect(cmd: Command): Client {
  const { url, cert, key, ca } = cmd.optsWithGlobals<Partial<CliConfig>>();
  client ??= createClient(loadConfig({ url, cert, key, ca }));
  return client;
}

function parseId(value: string): number {
  const m = /^#?(\d+)$/.exec(value.trim());
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new InvalidArgumentError(`"${value}" is not a spark id`);
  return n;
}

function parsePositive(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const note = (line: string): void => void process.stderr.write(`${dim(line)}\n`);

function checkBlurb(blurb: string | null) {
  if (blurb && blurb.length > MAX_BLURB_LENGTH) {
    throw new Error(`The text is ${blurb.length} characters; the limit is ${MAX_BLURB_LENGTH}`);
  }
}

function checkImageCount(n: number) {
  if (n > MAX_IMAGES_PER_SPARK) throw new Error(`A spark can have at most ${MAX_IMAGES_PER_SPARK} images (got ${n})`);
}

async function upload(api: Client, files: ImageFile[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    try {
      ids.push((await api.uploadImage(f.data, f.name)).id);
    } catch (err) {
      throw new Error(`Uploading ${f.name} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return ids;
}

/** Text from the words given, or stdin when the only word is "-". */
async function textArg(words: string[]): Promise<string> {
  return words.length === 1 && words[0] === "-" ? readStdin() : words.join(" ");
}

const normalize = (s: string) => s.replace(/\r\n?/g, "\n").trim() || null;

function printSpark(api: Client, spark: Spark, json: boolean, verb?: string) {
  if (json) return printJson(sparkJson(spark, api.fileUrl));
  if (verb) note(verb);
  out(sparkBlock(spark, api.fileUrl));
}

// ---- listing ---------------------------------------------------------------------

interface ListOpts {
  limit: number;
  all?: boolean;
  since?: string;
  until?: string;
  on?: string;
  long?: boolean;
  json?: boolean;
}

/** Pages through the newest-first feed, applying the time window client-side. */
async function collect(api: Client, q: string | undefined, opts: ListOpts) {
  const limit = opts.all ? Infinity : opts.limit;
  let since = opts.since ? parseWhen(opts.since, "start") : undefined;
  let until = opts.until ? parseWhen(opts.until, "end") : undefined;
  if (opts.on) {
    const day = parseDay(opts.on);
    if (!day) throw new Error(`--on needs a day (today, yesterday, a weekday, or YYYY-MM-DD), not "${opts.on}"`);
    since = day.start;
    until = day.end;
  }
  const pageSize = Number.isFinite(limit) && until === undefined ? Math.min(500, limit + 1) : 500;

  const sparks: Spark[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await api.list({ q, cursor, limit: pageSize });
    for (const s of page.sparks) {
      if (until !== undefined && s.createdAt >= until) continue;
      if (since !== undefined && s.createdAt < since) return { sparks, more: false };
      if (sparks.length >= limit) return { sparks, more: true };
      sparks.push(s);
    }
    if (!page.nextCursor) return { sparks, more: false };
    cursor = page.nextCursor;
  }
}

async function list(api: Client, q: string | undefined, opts: ListOpts) {
  const { sparks, more } = await collect(api, q, opts);
  if (opts.json) {
    printJson(sparks.map((s) => sparkJson(s, api.fileUrl)));
  } else if (sparks.length === 0) {
    note(q ? "No matching sparks." : "No sparks.");
  } else if (opts.long) {
    out(sparks.map((s) => sparkBlock(s, api.fileUrl)).join("\n\n"));
  } else {
    const idWidth = Math.max(...sparks.map((s) => String(s.id).length));
    for (const s of sparks) out(sparkLine(s, idWidth));
  }
  if (more) note(`Showing the newest ${sparks.length}; use -n <count> or --all for more.`);
}

const withListOptions = (cmd: Command) =>
  cmd
    .option("-n, --limit <count>", "maximum number of sparks", parsePositive, 20)
    .option("-a, --all", "no limit")
    .option("--since <when>", "only sparks created at or after this time")
    .option("--until <when>", "only sparks created before this time (a date includes that whole day)")
    .option("--on <day>", "only sparks from this day")
    .option("-l, --long", "show full text and image URLs")
    .option("--json", "print JSON");

// ---- program -------------------------------------------------------------------------

const program = new Command("wcspark")
  .description("Sparks journal CLI: capture and find links, ideas, screenshots, and notes.")
  .version(pkg.version)
  .option("--url <url>", "server URL (env WCSPARK_URL)")
  .option("--cert <file>", "client certificate PEM for mTLS (env WCSPARK_CERT)")
  .option("--key <file>", "client private key PEM (env WCSPARK_KEY)")
  .option("--ca <file>", "CA bundle PEM, if the server's certificate isn't publicly trusted (env WCSPARK_CA)")
  .showHelpAfterError("(run with --help for usage)")
  .addHelpText(
    "after",
    `
Examples:
  wcspark add Look into smithy.io for API codegen
  wcspark add "https://example.com/post?id=1" -i shot.png
  wcspark add -c                 clipboard image or text becomes a spark
  pbpaste | wcspark add          text from stdin
  wcspark add                    opens $EDITOR
  wcspark ls --since 7d
  wcspark search aws emulator
  wcspark edit 12 -a "follow-up thought"

Config: ~/.config/wcspark/config.json  {"url", "cert", "key", "ca"}; see \`wcspark config\`.`,
  );

program
  .command("add")
  .alias("a")
  .description("Add a spark. Text comes from the arguments, stdin, or $EDITOR.")
  .argument("[text...]", 'the text; words are joined with spaces. "-" reads stdin')
  .option("-i, --image <files...>", "attach image files (png, jpeg, webp, gif, avif)")
  .option("-c, --clipboard", "attach the clipboard image, or add the clipboard text")
  .option("--no-editor", "never open an editor")
  .option("--json", "print the new spark as JSON")
  .addHelpText(
    "after",
    `
With no text, images, or -c, text is read from stdin when it isn't a terminal,
otherwise $EDITOR opens. Put images after the text (or use "--" before the text),
since -i takes every following argument.`,
  )
  .action(async (words: string[], opts, cmd: Command) => {
    const images = ((opts.image ?? []) as string[]).map(readImageFile);
    const parts: string[] = [];
    const fromStdin = words.length === 1 && words[0] === "-";
    const text = await textArg(words);
    if (text.trim()) parts.push(text.trim());
    if (opts.clipboard) {
      const clip = readClipboard();
      if (clip.image) images.push(clip.image);
      else if (clip.text) parts.push(clip.text.trim());
      else throw new Error("The clipboard is empty");
    }
    if (!parts.length && !images.length && !fromStdin) {
      if (!stdinIsTTY()) parts.push(await readStdin());
      else if (opts.editor) parts.push(editText(""));
    }
    const blurb = normalize(parts.join("\n"));
    if (!blurb && !images.length) {
      throw new Error("Nothing to add: give some text, -i <image>, -c, or pipe text on stdin");
    }
    checkBlurb(blurb);
    checkImageCount(images.length);

    const api = connect(cmd);
    const imageIds = await upload(api, images);
    printSpark(api, await api.create({ blurb, imageIds }), opts.json, "Added:");
  });

withListOptions(
  program.command("ls").alias("list").description("List sparks, newest first."),
).action(async (opts: ListOpts, cmd: Command) => list(connect(cmd), undefined, opts));

withListOptions(
  program
    .command("search")
    .alias("find")
    .description("Search sparks: case-insensitive substrings; every term must match.")
    .argument("<terms...>", 'search terms; quote a phrase inside the argument to keep it together: \'"exact phrase"\''),
).action(async (terms: string[], opts: ListOpts, cmd: Command) => list(connect(cmd), terms.join(" "), opts));

program
  .command("show")
  .description("Show sparks in full.")
  .argument("<ids...>", "spark ids")
  .option("--json", "print JSON (an object for one id, an array for several)")
  .action(async (ids: string[], opts, cmd: Command) => {
    const api = connect(cmd);
    const sparks = await Promise.all(ids.map(parseId).map((id) => api.get(id)));
    if (opts.json) {
      const data = sparks.map((s) => sparkJson(s, api.fileUrl));
      return printJson(data.length === 1 ? data[0] : data);
    }
    out(sparks.map((s) => sparkBlock(s, api.fileUrl)).join("\n\n"));
  });

program
  .command("edit")
  .description("Edit a spark. Only the given changes are applied; with none, $EDITOR opens.")
  .argument("<id>", "spark id")
  .argument("[text...]", 'replacement text. "-" reads stdin; "" clears the text')
  .option("-a, --append <text>", 'append a line of text ("-" reads stdin)')
  .option("-i, --image <files...>", "attach more image files")
  .option("-c, --clipboard", "attach the clipboard image, or append the clipboard text")
  .option("-r, --rm-image <refs...>", "remove images by number (1 = first, as in `show`) or image id")
  .option("--clear-images", "remove all images")
  .option("-e, --editor", "open the text in $EDITOR (after any other text changes)")
  .option("--json", "print the updated spark as JSON")
  .action(async (idArg: string, words: string[], opts, cmd: Command) => {
    const id = parseId(idArg);
    const api = connect(cmd);
    const spark = await api.get(id);
    let blurb = spark.blurb ?? "";
    let imageIds = spark.images.map((img) => img.id);
    const append = (t: string) => {
      blurb = blurb.trim() ? `${blurb.trimEnd()}\n${t.trim()}` : t.trim();
    };

    if (words.length) blurb = await textArg(words);
    if (opts.append !== undefined) append(opts.append === "-" ? await readStdin() : opts.append);

    if (opts.clearImages) imageIds = [];
    if (opts.rmImage) {
      const drop = new Set<string>();
      for (const ref of opts.rmImage as string[]) {
        const n = /^\d+$/.test(ref) ? Number(ref) : NaN;
        const imgId = Number.isInteger(n) ? spark.images[n - 1]?.id : spark.images.find((i) => i.id === ref)?.id;
        if (!imgId) throw new Error(`Spark #${id} has no image "${ref}" (it has ${spark.images.length})`);
        drop.add(imgId);
      }
      imageIds = imageIds.filter((i) => !drop.has(i));
    }

    const newImages = ((opts.image ?? []) as string[]).map(readImageFile);
    if (opts.clipboard) {
      const clip = readClipboard();
      if (clip.image) newImages.push(clip.image);
      else if (clip.text) append(clip.text);
      else throw new Error("The clipboard is empty");
    }

    const otherChanges =
      words.length || opts.append !== undefined || opts.clearImages || opts.rmImage || newImages.length || opts.clipboard;
    if (opts.editor || !otherChanges) {
      if (!stdinIsTTY()) {
        throw new Error(
          opts.editor
            ? "--editor needs a terminal"
            : "Nothing to change: give replacement text, -a, -i, -c, -r, or --clear-images",
        );
      }
      blurb = editText(blurb);
    }

    const newBlurb = normalize(blurb);
    checkBlurb(newBlurb);
    checkImageCount(imageIds.length + newImages.length);
    if (newBlurb === spark.blurb && !newImages.length && imageIds.join() === spark.images.map((i) => i.id).join()) {
      note(`No changes to #${id}.`);
      if (opts.json) printJson(sparkJson(spark, api.fileUrl));
      return;
    }
    if (!newBlurb && imageIds.length + newImages.length === 0) {
      throw new Error("A spark needs text or at least one image; use `wcspark rm` to delete it");
    }
    imageIds.push(...(await upload(api, newImages)));
    printSpark(api, await api.update(id, { blurb: newBlurb, imageIds }), opts.json, "Updated:");
  });

program
  .command("rm")
  .alias("delete")
  .description("Delete sparks and their images permanently.")
  .argument("<ids...>", "spark ids")
  .option("-y, --yes", "don't ask for confirmation (required when not in a terminal)")
  .action(async (ids: string[], opts, cmd: Command) => {
    const nums = ids.map(parseId);
    const api = connect(cmd);
    if (!opts.yes) {
      if (!stdinIsTTY()) throw new Error("Refusing to delete without -y (not running in a terminal)");
      const sparks = await Promise.all(nums.map((id) => api.get(id)));
      const idWidth = Math.max(...nums.map((n) => String(n).length));
      for (const s of sparks) out(sparkLine(s, idWidth));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Delete ${nums.length === 1 ? "this spark" : `these ${nums.length} sparks`}? [y/N] `);
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) return note("Not deleted.");
    }
    for (const id of nums) {
      try {
        await api.remove(id);
        out(`Deleted #${id}`);
      } catch (err) {
        process.stderr.write(`wcspark: #${id}: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    }
  });

program
  .command("download")
  .alias("dl")
  .description("Download images, by spark id (all of its images) or image id. Prints the saved paths.")
  .argument("<refs...>", "spark ids and/or image ids")
  .option("-o, --output <path>", 'directory (default: current), a file name for a single image, or "-" for stdout')
  .option("--thumb", "download the ≤840px WebP thumbnail instead of the original")
  .action(async (refs: string[], opts, cmd: Command) => {
    const api = connect(cmd);
    const imageIds: string[] = [];
    for (const ref of refs) {
      if (IMAGE_ID_RE.test(ref)) {
        imageIds.push(ref);
        continue;
      }
      const spark = await api.get(parseId(ref));
      if (!spark.images.length) throw new Error(`Spark #${spark.id} has no images`);
      imageIds.push(...spark.images.map((i) => i.id));
    }

    const output: string | undefined = opts.output;
    if (output === "-") {
      if (imageIds.length !== 1) throw new Error(`"-o -" needs exactly one image (got ${imageIds.length})`);
      const { data } = await api.downloadImage(imageIds[0]!, opts.thumb);
      process.stdout.write(data);
      return;
    }
    const intoDir =
      !output || imageIds.length > 1 || output.endsWith("/") || (existsSync(output) && statSync(output).isDirectory());
    const dir = resolve(intoDir ? (output ?? ".") : ".");
    if (intoDir) mkdirSync(dir, { recursive: true });
    for (const imageId of imageIds) {
      const { data, mime } = await api.downloadImage(imageId, opts.thumb);
      const file = intoDir ? join(dir, `${imageId}.${EXT_BY_MIME[mime] ?? "bin"}`) : resolve(output!);
      writeFileSync(file, data);
      out(file);
    }
  });

program
  .command("export")
  .description("Export every spark to <dir>/sparks.json and original images to <dir>/images/.")
  .argument("<dir>", "destination directory; images already there are not downloaded again")
  .action(async (dirArg: string, _opts, cmd: Command) => {
    const api = connect(cmd);
    const dir = resolve(dirArg);
    const imagesDir = join(dir, "images");
    mkdirSync(imagesDir, { recursive: true });
    const { sparks } = await collect(api, undefined, { limit: 0, all: true });
    let fetched = 0;
    let total = 0;
    for (const s of sparks) {
      for (const img of s.images) {
        total++;
        const file = join(imagesDir, `${img.id}.${EXT_BY_MIME[img.mime] ?? "bin"}`);
        if (existsSync(file)) continue;
        writeFileSync(file, (await api.downloadImage(img.id)).data);
        fetched++;
      }
    }
    writeFileSync(join(dir, "sparks.json"), `${JSON.stringify(sparks, null, 2)}\n`);
    out(`Exported ${sparks.length} sparks and ${total} images (${fetched} downloaded) to ${dir}`);
  });

program
  .command("open")
  .description("Open the web app in a browser, optionally with a search.")
  .argument("[query...]", "search terms")
  .action((query: string[], _opts, cmd: Command) => {
    const { url } = loadConfig(cmd.optsWithGlobals<Partial<CliConfig>>());
    const target = query.length ? `${url}/?${new URLSearchParams({ q: query.join(" ") })}` : `${url}/`;
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [target], { detached: true, stdio: "ignore" }).on("error", () => out(target)).unref();
  });

program
  .command("config")
  .description("Show the effective connection settings (without contacting the server).")
  .option("--check", "also make a test request to the server")
  .option("--json", "print JSON")
  .action(async (opts, cmd: Command) => {
    const g = cmd.optsWithGlobals<Partial<CliConfig>>();
    const cfg = loadConfig({ url: g.url, cert: g.cert, key: g.key, ca: g.ca });
    if (opts.json) {
      printJson({ url: cfg.url, cert: cfg.cert ?? null, key: cfg.key ?? null, ca: cfg.ca ?? null, sources: cfg.sources, configFile: cfg.configFile });
    } else {
      out(`config file  ${cfg.configFile}${cfg.configFileExists ? "" : dim(" (not found)")}`);
      for (const k of ["url", "cert", "key", "ca"] as const) {
        const src = cfg.sources[k];
        out(`${k.padEnd(4)}         ${cfg[k] ?? dim("(not set)")}${src ? dim(`  [${src}]`) : ""}`);
      }
    }
    if (opts.check) {
      await connect(cmd).list({ limit: 1 });
      note(`OK: connected to ${cfg.url}`);
    }
  });

// ---- run ------------------------------------------------------------------------------

try {
  await program.parseAsync();
} catch (err) {
  process.stderr.write(`wcspark: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  client?.close();
}
