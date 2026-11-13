import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { openDb } from "./db.js";
import { IMAGE_ID_RE, ImageStore } from "./images.js";
import { HttpError, SparkRepo } from "./repo.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_BLURB_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_SPARK,
} from "../shared/types.js";

const PENDING_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

const sparkInputSchema = z.object({
  blurb: z.string().max(MAX_BLURB_LENGTH).nullable().default(null),
  imageIds: z.array(z.string().regex(IMAGE_ID_RE)).max(MAX_IMAGES_PER_SPARK).default([]),
});

const listQuerySchema = z.object({
  q: z.string().max(500).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_PAGE_SIZE),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const imageParamSchema = z.object({ id: z.string().regex(IMAGE_ID_RE) });

export interface AppOptions {
  dataDir: string;
  logger?: boolean;
  /** Directory containing the built client; served when present. */
  clientDir?: string;
}

export interface App {
  server: FastifyInstance;
  cleanupPendingImages(now?: number): Promise<number>;
  close(): Promise<void>;
}

export async function buildApp(opts: AppOptions): Promise<App> {
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const db = openDb(path.join(opts.dataDir, "sparks.db"));
  const repo = new SparkRepo(db);
  const store = new ImageStore(opts.dataDir);

  const server = Fastify({ logger: opts.logger ?? false });
  await server.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_SPARK, fields: 10, fieldSize: 64 * 1024 },
  });

  server.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  // ---- sparks ---------------------------------------------------------------

  server.get("/api/sparks", async (req) => {
    const { q, cursor, limit } = listQuerySchema.parse(req.query);
    return repo.list({ q, cursor, limit });
  });

  server.get("/api/sparks/:id", async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const spark = repo.get(id);
    if (!spark) throw new HttpError(404, "Spark not found");
    return spark;
  });

  server.post("/api/sparks", async (req, reply) => {
    const input = sparkInputSchema.parse(req.body);
    return reply.code(201).send(repo.create(input));
  });

  server.put("/api/sparks/:id", async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const input = sparkInputSchema.parse(req.body);
    const { spark, removed } = repo.update(id, input);
    await store.remove(removed);
    return spark;
  });

  server.delete("/api/sparks/:id", async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    await store.remove(repo.delete(id));
    return reply.code(204).send();
  });

  // ---- images ---------------------------------------------------------------

  server.post("/api/images", async (req, reply) => {
    const file = await req.file();
    if (!file) throw new HttpError(400, "Expected a file upload");
    const buf = await file.toBuffer(); // throws 413 when over the size limit
    const row = await store.save(buf);
    repo.insertPendingImage(row);
    return reply
      .code(201)
      .send({ id: row.id, mime: row.mime, width: row.width, height: row.height });
  });

  const serveImage = (variant: "original" | "thumb") => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = imageParamSchema.parse(req.params);
    const img = repo.getImage(id);
    if (!img) throw new HttpError(404, "Image not found");
    const file = variant === "thumb" ? store.thumbPath(img) : store.originalPath(img);
    reply
      .type(variant === "thumb" ? "image/webp" : img.mime)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(fs.createReadStream(file));
  };
  server.get("/files/:id", serveImage("original"));
  server.get("/files/:id/thumb", serveImage("thumb"));

  // ---- PWA share target -------------------------------------------------------
  // The manifest's share_target POSTs here. We stage any images as pending uploads and
  // redirect to the app with the composer pre-filled; the user reviews and saves.

  server.post("/share", async (req, reply) => {
    const fields: Record<string, string> = {};
    const imageIds: string[] = [];
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (typeof part.value === "string") fields[part.fieldname] = part.value.trim();
      } else {
        try {
          const row = await store.save(await part.toBuffer());
          repo.insertPendingImage(row);
          imageIds.push(row.id);
        } catch (err) {
          req.log.warn({ err, filename: part.filename }, "ignoring shared file");
          if (!part.file.readableEnded) part.file.resume();
        }
      }
    }
    const params = new URLSearchParams({ share: "1" });
    const text = composeSharedText(fields.title, fields.text, fields.url);
    if (text) params.set("text", text.slice(0, MAX_BLURB_LENGTH));
    if (imageIds.length) params.set("images", imageIds.join(","));
    // Use the fragment so shared content never shows up in proxy access logs.
    return reply.redirect(`/#${params}`, 303);
  });
  server.get("/share", async (_req, reply) => reply.redirect("/", 303));

  // ---- static client ------------------------------------------------------------

  const clientDir =
    opts.clientDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
  if (fs.existsSync(path.join(clientDir, "index.html"))) {
    await server.register(fastifyStatic, {
      root: clientDir,
      wildcard: false,
      setHeaders(res, filePath) {
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    server.setNotFoundHandler((req, reply) => {
      const url = req.url.split("?")[0]!;
      if (req.method === "GET" && !url.startsWith("/api/") && !url.startsWith("/files/")) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return {
    server,
    async cleanupPendingImages(now = Date.now()) {
      const removed = repo.deletePendingImages(now - PENDING_IMAGE_TTL_MS);
      await store.remove(removed);
      return removed.length;
    },
    async close() {
      await server.close();
      db.close();
    },
  };
}

/** Android share sheets send title/text/url inconsistently (the URL is often inside text); dedupe. */
export function composeSharedText(title?: string, text?: string, url?: string): string {
  const parts = [...new Set([title, text, url].filter((p): p is string => !!p))];
  return parts.filter((p, i) => !parts.some((o, j) => j !== i && o.includes(p))).join("\n");
}
