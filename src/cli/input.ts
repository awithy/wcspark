import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_IMAGE_BYTES } from "../shared/types.js";

export const stdinIsTTY = () => Boolean(process.stdin.isTTY);

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Opens $VISUAL / $EDITOR on `initial` and returns the saved text. */
export function editText(initial: string): string {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "wcspark-"));
  const file = join(dir, "spark.md");
  try {
    writeFileSync(file, initial);
    // Run through the shell so editors configured with arguments (e.g. "code -w") work.
    const res = spawnSync(`${editor} "$WCSPARK_EDIT_FILE"`, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, WCSPARK_EDIT_FILE: file },
    });
    if (res.error) throw new Error(`Could not run editor "${editor}": ${res.error.message}`);
    if (res.status !== 0) throw new Error(`Editor "${editor}" exited with status ${res.status}; nothing saved`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ImageFile {
  name: string;
  data: Buffer;
}

export function readImageFile(path: string): ImageFile {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a regular file");
    size = st.size;
  } catch (err) {
    throw new Error(`Cannot read image ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`Image ${path} is ${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB`);
  }
  return { name: basename(path), data: readFileSync(path) };
}

// ---- clipboard ---------------------------------------------------------------

export interface ClipboardContent {
  image?: ImageFile;
  text?: string;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];

function run(cmd: string, args: string[], binary = false): Buffer | string | null {
  const res = spawnSync(cmd, args, { encoding: binary ? "buffer" : "utf8", maxBuffer: MAX_IMAGE_BYTES * 2 });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

/** Reads the system clipboard: an image if one is on it, otherwise text. */
export function readClipboard(): ClipboardContent {
  let list: () => string[];
  let get: (type: string) => Buffer | null;

  if (process.env.WAYLAND_DISPLAY && run("which", ["wl-paste"])) {
    list = () => String(run("wl-paste", ["--list-types"]) ?? "").split("\n");
    get = (type) => run("wl-paste", ["--no-newline", "--type", type], true) as Buffer | null;
  } else if (process.env.DISPLAY && run("which", ["xclip"])) {
    const sel = ["-selection", "clipboard", "-o"];
    list = () => String(run("xclip", [...sel, "-t", "TARGETS"]) ?? "").split("\n");
    get = (type) => run("xclip", [...sel, "-t", type], true) as Buffer | null;
  } else if (process.platform === "darwin") {
    const text = run("pbpaste", []);
    return text ? { text: String(text) } : {};
  } else {
    throw new Error("No clipboard available: needs wl-paste (Wayland) or xclip (X11) and a graphical session");
  }

  const types = list().map((t) => t.trim());
  const imageType = IMAGE_TYPES.find((t) => types.includes(t));
  if (imageType) {
    const data = get(imageType);
    if (data?.length) {
      if (data.length > MAX_IMAGE_BYTES) throw new Error("The clipboard image is larger than the upload limit");
      return { image: { name: `clipboard.${imageType.split("/")[1]}`, data } };
    }
  }
  const textType = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING"].find((t) => types.includes(t));
  const text = textType ? get(textType)?.toString("utf8") : undefined;
  return text?.trim() ? { text } : {};
}
