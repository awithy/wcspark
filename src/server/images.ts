import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { HttpError, type StoredImage } from "./repo.js";

/** Formats browsers can display natively; anything else (including SVG) is rejected. */
const FORMATS: Record<string, { mime: string; ext: string }> = {
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png: { mime: "image/png", ext: "png" },
  webp: { mime: "image/webp", ext: "webp" },
  gif: { mime: "image/gif", ext: "gif" },
  avif: { mime: "image/avif", ext: "avif" },
};

/** Thumbnails cover the small feed previews at 2x pixel density. */
const THUMB_MAX = 840;
export const IMAGE_ID_RE = /^[A-Za-z0-9_-]{16}$/;

export class ImageStore {
  readonly originalsDir: string;
  readonly thumbsDir: string;

  constructor(dataDir: string) {
    this.originalsDir = path.join(dataDir, "images");
    this.thumbsDir = path.join(dataDir, "thumbs");
    fs.mkdirSync(this.originalsDir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
  }

  originalPath(img: Pick<StoredImage, "id" | "ext">) {
    return path.join(this.originalsDir, `${img.id}.${img.ext}`);
  }

  thumbPath(img: Pick<StoredImage, "id">) {
    return path.join(this.thumbsDir, `${img.id}.webp`);
  }

  /**
   * Validates an uploaded image, writes the original and a WebP thumbnail to disk,
   * and returns metadata for the database row.
   */
  async save(buf: Buffer, now = Date.now()): Promise<Omit<StoredImage, "spark_id" | "position">> {
    let meta: Metadata;
    try {
      meta = await sharp(buf, { animated: true }).metadata();
    } catch {
      throw new HttpError(415, "Unsupported or corrupt image");
    }
    const formatKey =
      meta.format === "heif" ? (meta.compression === "av1" ? "avif" : "heic") : meta.format;
    const format = formatKey ? FORMATS[formatKey] : undefined;
    if (!format || !meta.width || !meta.height) {
      throw new HttpError(415, `Unsupported image format${formatKey ? `: ${formatKey}` : ""}`);
    }

    const animated = (meta.pages ?? 1) > 1;
    let width = meta.width;
    let height = meta.pageHeight ?? meta.height;
    // EXIF orientations 5–8 are rotated 90°, so the displayed dimensions are swapped.
    if ((meta.orientation ?? 1) >= 5) [width, height] = [height, width];

    const id = randomBytes(12).toString("base64url");
    const row = { id, mime: format.mime, ext: format.ext, width, height, bytes: buf.length, created_at: now };

    let pipeline = sharp(buf, { animated });
    if (!animated) pipeline = pipeline.rotate(); // apply EXIF orientation
    await pipeline
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(this.thumbPath(row));
    await fs.promises.writeFile(this.originalPath(row), buf);
    return row;
  }

  async remove(images: Pick<StoredImage, "id" | "ext">[]) {
    await Promise.all(
      images.flatMap((img) => [this.originalPath(img), this.thumbPath(img)]).map((p) =>
        fs.promises.rm(p, { force: true }),
      ),
    );
  }
}
