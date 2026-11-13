import type { DB } from "./db.js";
import {
  MAX_IMAGES_PER_SPARK,
  type Spark,
  type SparkImage,
  type SparkInput,
  type SparkPage,
} from "../shared/types.js";
import { parseQuery } from "../shared/query.js";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface SparkRow {
  id: number;
  blurb: string | null;
  created_at: number;
  updated_at: number;
}

interface ImageRow {
  id: string;
  spark_id: number | null;
  position: number;
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
}

export type StoredImage = ImageRow;

// ---------------------------------------------------------------------------
// Cursors: newest-first keyset pagination on (created_at, id).

function encodeCursor(row: SparkRow): string {
  return Buffer.from(`${row.created_at}:${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: number; id: number } {
  const [a, b] = Buffer.from(cursor, "base64url").toString().split(":");
  const createdAt = Number(a);
  const id = Number(b);
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(id)) {
    throw new HttpError(400, "Invalid cursor");
  }
  return { createdAt, id };
}

// ---------------------------------------------------------------------------
// Search query parsing.

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const quoteFts = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface Where {
  clauses: string[];
  params: unknown[];
}

function searchWhere(q: string): Where {
  const where: Where = { clauses: [], params: [] };
  const ftsTerms: string[] = [];
  for (const term of parseQuery(q)) {
    // The trigram tokenizer can't match terms shorter than 3 characters, so fall back to LIKE.
    if ([...term].length >= 3) {
      ftsTerms.push(quoteFts(term));
    } else {
      where.clauses.push(`s.blurb LIKE ? ESCAPE '\\'`);
      where.params.push(`%${escapeLike(term)}%`);
    }
  }
  if (ftsTerms.length) {
    where.clauses.push(`s.id IN (SELECT rowid FROM sparks_fts WHERE sparks_fts MATCH ?)`);
    where.params.push(ftsTerms.join(" "));
  }
  return where;
}

// ---------------------------------------------------------------------------

export class SparkRepo {
  constructor(private db: DB) {}

  private attachImages(rows: SparkRow[]): Spark[] {
    if (rows.length === 0) return [];
    const images = this.db
      .prepare<[string], ImageRow>(
        `SELECT * FROM images
         WHERE spark_id IN (SELECT value FROM json_each(?))
         ORDER BY spark_id, position`,
      )
      .all(JSON.stringify(rows.map((r) => r.id)));
    const bySpark = new Map<number, SparkImage[]>();
    for (const img of images) {
      const list = bySpark.get(img.spark_id!) ?? [];
      list.push({ id: img.id, mime: img.mime, width: img.width, height: img.height });
      bySpark.set(img.spark_id!, list);
    }
    return rows.map((r) => ({
      id: r.id,
      blurb: r.blurb,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      images: bySpark.get(r.id) ?? [],
    }));
  }

  list(opts: { q?: string; cursor?: string; limit: number }): SparkPage {
    const where: Where = opts.q?.trim() ? searchWhere(opts.q) : { clauses: [], params: [] };
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      where.clauses.push(`(s.created_at < ? OR (s.created_at = ? AND s.id < ?))`);
      where.params.push(c.createdAt, c.createdAt, c.id);
    }
    const sql = `SELECT s.* FROM sparks s
      ${where.clauses.length ? `WHERE ${where.clauses.join(" AND ")}` : ""}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ?`;
    const rows = this.db.prepare<unknown[], SparkRow>(sql).all(...where.params, opts.limit + 1);
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    return {
      sparks: this.attachImages(page),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  get(id: number): Spark | null {
    const row = this.db.prepare<[number], SparkRow>(`SELECT * FROM sparks WHERE id = ?`).get(id);
    return row ? this.attachImages([row])[0]! : null;
  }

  /** Creates a spark; returns it. */
  create(input: SparkInput, now = Date.now()): Spark {
    const blurb = normalizeBlurb(input.blurb);
    assertNotEmpty(blurb, input.imageIds);
    const id = this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(`INSERT INTO sparks (blurb, created_at, updated_at) VALUES (?, ?, ?)`)
        .run(blurb, now, now);
      const sparkId = Number(lastInsertRowid);
      this.setImages(sparkId, input.imageIds);
      return sparkId;
    })();
    return this.get(id)!;
  }

  /** Updates a spark; returns it and the images that were detached (whose files should be removed). */
  update(id: number, input: SparkInput, now = Date.now()): { spark: Spark; removed: StoredImage[] } {
    const blurb = normalizeBlurb(input.blurb);
    assertNotEmpty(blurb, input.imageIds);
    const removed = this.db.transaction(() => {
      const res = this.db
        .prepare(`UPDATE sparks SET blurb = ?, updated_at = ? WHERE id = ?`)
        .run(blurb, now, id);
      if (res.changes === 0) throw new HttpError(404, "Spark not found");
      return this.setImages(id, input.imageIds);
    })();
    return { spark: this.get(id)!, removed };
  }

  /** Deletes a spark; returns its images (whose files should be removed). */
  delete(id: number): StoredImage[] {
    return this.db.transaction(() => {
      const images = this.db
        .prepare<[number], ImageRow>(`SELECT * FROM images WHERE spark_id = ?`)
        .all(id);
      const res = this.db.prepare(`DELETE FROM sparks WHERE id = ?`).run(id);
      if (res.changes === 0) throw new HttpError(404, "Spark not found");
      return images; // rows removed by ON DELETE CASCADE
    })();
  }

  /** Attaches exactly `imageIds` (in order) to the spark. Returns images that were detached and deleted. */
  private setImages(sparkId: number, imageIds: string[]): StoredImage[] {
    if (new Set(imageIds).size !== imageIds.length) throw new HttpError(400, "Duplicate image ids");
    if (imageIds.length > MAX_IMAGES_PER_SPARK) {
      throw new HttpError(400, `At most ${MAX_IMAGES_PER_SPARK} images per spark`);
    }
    const getImage = this.db.prepare<[string], ImageRow>(`SELECT * FROM images WHERE id = ?`);
    for (const imageId of imageIds) {
      const img = getImage.get(imageId);
      if (!img || (img.spark_id !== null && img.spark_id !== sparkId)) {
        throw new HttpError(400, `Unknown image ${imageId}`);
      }
    }
    const current = this.db
      .prepare<[number], ImageRow>(`SELECT * FROM images WHERE spark_id = ?`)
      .all(sparkId);
    const keep = new Set(imageIds);
    const removed = current.filter((img) => !keep.has(img.id));
    const del = this.db.prepare(`DELETE FROM images WHERE id = ?`);
    for (const img of removed) del.run(img.id);
    const attach = this.db.prepare(`UPDATE images SET spark_id = ?, position = ? WHERE id = ?`);
    imageIds.forEach((imageId, i) => attach.run(sparkId, i, imageId));
    return removed;
  }

  // ---- images -------------------------------------------------------------

  insertPendingImage(img: Omit<ImageRow, "spark_id" | "position">) {
    this.db
      .prepare(
        `INSERT INTO images (id, spark_id, position, mime, ext, width, height, bytes, created_at)
         VALUES (@id, NULL, 0, @mime, @ext, @width, @height, @bytes, @created_at)`,
      )
      .run(img);
  }

  getImage(id: string): StoredImage | null {
    return this.db.prepare<[string], ImageRow>(`SELECT * FROM images WHERE id = ?`).get(id) ?? null;
  }

  /** Deletes pending (never attached) images created before `before`; returns them. */
  deletePendingImages(before: number): StoredImage[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare<[number], ImageRow>(`SELECT * FROM images WHERE spark_id IS NULL AND created_at < ?`)
        .all(before);
      const del = this.db.prepare(`DELETE FROM images WHERE id = ?`);
      for (const r of rows) del.run(r.id);
      return rows;
    })();
  }
}

export function normalizeBlurb(blurb: string | null | undefined): string | null {
  if (blurb == null) return null;
  const s = blurb.replace(/\r\n?/g, "\n").trim();
  return s.length ? s : null;
}

function assertNotEmpty(blurb: string | null, imageIds: string[]) {
  if (!blurb && imageIds.length === 0) {
    throw new HttpError(400, "A spark needs a blurb or at least one image");
  }
}
