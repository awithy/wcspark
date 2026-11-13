import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Spark, SparkImage, SparkInput, SparkPage } from "../shared/types.js";
import type { CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface RequestOptions {
  json?: unknown;
  body?: Buffer;
  contentType?: string;
}

const TIMEOUT_MS = 60_000;

function readPem(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`Could not read ${what} ${path}: ${(err as Error).message}`, { cause: err });
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

export const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export function mimeForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function createClient(config: CliConfig) {
  const base = new URL(config.url);
  const secure = base.protocol === "https:";
  if (!secure && base.protocol !== "http:") throw new Error(`Unsupported URL scheme: ${config.url}`);

  // The reverse proxy in front of the server enforces mTLS; the app itself never sees certificates.
  const agent = secure
    ? new https.Agent({
        keepAlive: true,
        cert: config.cert ? readPem(config.cert, "client certificate") : undefined,
        key: config.key ? readPem(config.key, "client key") : undefined,
        ca: config.ca ? readPem(config.ca, "CA bundle") : undefined,
      })
    : new http.Agent({ keepAlive: true });

  function raw(method: string, path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const url = new URL(path, base);
    let body = opts.body;
    const headers: Record<string, string> = { accept: "application/json, */*" };
    if (opts.json !== undefined) {
      body = Buffer.from(JSON.stringify(opts.json));
      headers["content-type"] = "application/json";
    } else if (opts.contentType) {
      headers["content-type"] = opts.contentType;
    }
    if (body) headers["content-length"] = String(body.length);

    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(url, { method, headers, agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      });
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)));
      req.on("error", (err) => reject(connectionError(err)));
      req.end(body);
    });
  }

  function connectionError(err: Error): Error {
    let msg = `Could not reach ${config.url}: ${err.message}`;
    if (/certificate required|alert handshake failure|bad certificate/i.test(err.message)) {
      msg += config.cert
        ? "\nThe server rejected the client certificate."
        : "\nThe server requires a client certificate; configure cert and key (see `wcspark config`).";
    }
    return new Error(msg, { cause: err });
  }

  async function request(method: string, path: string, opts?: RequestOptions): Promise<RawResponse> {
    const res = await raw(method, path, opts);
    if (res.status < 200 || res.status >= 300) {
      let message = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(res.body.toString()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, message);
    }
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await request(method, path, body === undefined ? {} : { json: body });
    return (res.status === 204 ? undefined : JSON.parse(res.body.toString())) as T;
  }

  return {
    url: config.url,
    fileUrl: (imageId: string) => `${config.url}/files/${imageId}`,

    list(opts: { q?: string; cursor?: string | null; limit?: number }) {
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      return json<SparkPage>("GET", `/api/sparks?${params}`);
    },
    get: (id: number) => json<Spark>("GET", `/api/sparks/${id}`),
    create: (input: SparkInput) => json<Spark>("POST", "/api/sparks", input),
    update: (id: number, input: SparkInput) => json<Spark>("PUT", `/api/sparks/${id}`, input),
    remove: (id: number) => json<void>("DELETE", `/api/sparks/${id}`),

    async uploadImage(data: Buffer, filename: string): Promise<SparkImage> {
      const boundary = `----wcspark${randomBytes(12).toString("hex")}`;
      const safeName = filename.replace(/[^\w.\- ]/g, "_") || "image";
      const head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${mimeForFilename(filename)}\r\n\r\n`;
      const body = Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const res = await request("POST", "/api/images", {
        body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
      return JSON.parse(res.body.toString()) as SparkImage;
    },

    /** Downloads an image (original, or the WebP thumbnail). */
    async downloadImage(imageId: string, thumb = false): Promise<{ data: Buffer; mime: string }> {
      const res = await request("GET", `/files/${encodeURIComponent(imageId)}${thumb ? "/thumb" : ""}`);
      const mime = String(res.headers["content-type"] ?? "application/octet-stream").split(";")[0]!;
      return { data: res.body, mime };
    },

    close: () => agent.destroy(),
  };
}

export type Client = ReturnType<typeof createClient>;
