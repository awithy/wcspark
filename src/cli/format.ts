import type { Spark } from "../shared/types.js";

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = sgr("2");
export const bold = sgr("1");

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD HH:mm`. */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** One-line summary: id, time, first line of the blurb, image count. */
export function sparkLine(s: Spark, idWidth: number): string {
  const id = `#${s.id}`.padStart(idWidth + 1);
  const lines = (s.blurb ?? "").split("\n");
  let text = lines[0] ?? "";
  if (lines.length > 1) text += " …";
  const tag = s.images.length ? `[${plural(s.images.length, "image")}]` : "";
  if (!text) text = tag ? "" : "(empty)";

  const head = `${id}  ${fmtTime(s.createdAt)}  `;
  const width = process.stdout.isTTY ? process.stdout.columns || 100 : Infinity;
  const room = width - head.length - (tag ? tag.length + 2 : 0);
  if (Number.isFinite(room)) text = truncate(text, Math.max(10, room));
  return `${bold(id)}  ${dim(fmtTime(s.createdAt))}  ${text}${tag ? `${text ? "  " : ""}${dim(tag)}` : ""}`;
}

/** Full view: header, the whole blurb, and images with their URLs. */
export function sparkBlock(s: Spark, fileUrl: (id: string) => string): string {
  let head = `${bold(`#${s.id}`)}  ${dim(fmtTime(s.createdAt))}`;
  if (s.updatedAt - s.createdAt > 1000) head += dim(`  (edited ${fmtTime(s.updatedAt)})`);
  const out = [head];
  if (s.blurb) out.push(s.blurb);
  s.images.forEach((img, i) => {
    const kind = img.mime.replace("image/", "");
    out.push(dim(`  [${i + 1}] ${img.id}  ${kind} ${img.width}×${img.height}  ${fileUrl(img.id)}`));
  });
  return out.join("\n");
}

/** JSON output: the API shape, plus an absolute `url` for each image. */
export function sparkJson(s: Spark, fileUrl: (id: string) => string) {
  return { ...s, images: s.images.map((img) => ({ ...img, url: fileUrl(img.id) })) };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
