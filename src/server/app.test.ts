import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, composeSharedText, type App } from "./app.js";
import type { Spark, SparkImage, SparkPage } from "../shared/types.js";

let dataDir: string;
let app: App;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcspark-test-"));
  app = await buildApp({ dataDir, clientDir: path.join(dataDir, "no-client") });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function multipartBody(parts: { name: string; value: string | Buffer; filename?: string; type?: string }[]) {
  const boundary = "----wcsparktest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) header += `; filename="${p.filename}"\r\nContent-Type: ${p.type ?? "application/octet-stream"}`;
    chunks.push(Buffer.from(header + "\r\n\r\n"), Buffer.from(p.value), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const png = (width = 40, height = 20) =>
  sharp({ create: { width, height, channels: 3, background: "#f80" } }).png().toBuffer();

async function upload(buf: Buffer, filename = "a.png"): Promise<SparkImage> {
  const res = await app.server.inject({
    method: "POST",
    url: "/api/images",
    ...multipartBody([{ name: "file", value: buf, filename, type: "image/png" }]),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function create(body: object): Promise<Spark> {
  const res = await app.server.inject({ method: "POST", url: "/api/sparks", payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function list(query = ""): Promise<SparkPage> {
  const res = await app.server.inject({ method: "GET", url: `/api/sparks${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const search = async (q: string) =>
  (await list(`?q=${encodeURIComponent(q)}`)).sparks.map((s) => s.blurb);

describe("sparks", () => {
  it("creates, lists newest first, edits and deletes", async () => {
    const a = await create({ blurb: "first" });
    const b = await create({ blurb: "  second\r\nline  " });
    expect(b.blurb).toBe("second\nline");
    expect((await list()).sparks.map((s) => s.id)).toEqual([b.id, a.id]);

    const res = await app.server.inject({ method: "PUT", url: `/api/sparks/${a.id}`, payload: { blurb: "edited" } });
    expect(res.json().blurb).toBe("edited");

    expect((await app.server.inject({ method: "DELETE", url: `/api/sparks/${a.id}` })).statusCode).toBe(204);
    expect((await app.server.inject({ method: "GET", url: `/api/sparks/${a.id}` })).statusCode).toBe(404);
  });

  it("rejects empty and over-long sparks", async () => {
    for (const payload of [{}, { blurb: "   " }, { blurb: "x".repeat(4001) }]) {
      const res = await app.server.inject({ method: "POST", url: "/api/sparks", payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("paginates with a cursor", async () => {
    for (let i = 0; i < 5; i++) await create({ blurb: `spark ${i}` });
    const p1 = await list("?limit=2");
    expect(p1.sparks.map((s) => s.blurb)).toEqual(["spark 4", "spark 3"]);
    const p2 = await list(`?limit=2&cursor=${p1.nextCursor}`);
    expect(p2.sparks.map((s) => s.blurb)).toEqual(["spark 2", "spark 1"]);
    const p3 = await list(`?limit=2&cursor=${p2.nextCursor}`);
    expect(p3.sparks.map((s) => s.blurb)).toEqual(["spark 0"]);
    expect(p3.nextCursor).toBeNull();
  });
});

describe("search", () => {
  beforeEach(async () => {
    await create({ blurb: "Look into Kubernetes operators" });
    await create({ blurb: "Great article https://example.com/posts/sqlite-fts5-tricks" });
    await create({ blurb: "Go 1.30 release notes" });
    await create({ blurb: 'Weird chars: 100% "quoted" under_score' });
  });

  it("matches substrings case-insensitively", async () => {
    expect(await search("kube")).toEqual(["Look into Kubernetes operators"]);
    expect(await search("FTS5-TRICKS")).toHaveLength(1);
  });

  it("ANDs terms and supports quoted phrases", async () => {
    expect(await search("article sqlite")).toHaveLength(1);
    expect(await search("article kube")).toHaveLength(0);
    expect(await search('"into kubernetes"')).toHaveLength(1);
    expect(await search('"kubernetes into"')).toHaveLength(0);
  });

  it("handles short terms and special characters", async () => {
    expect(await search("go")).toEqual(["Go 1.30 release notes"]);
    expect(await search("go notes")).toEqual(["Go 1.30 release notes"]);
    expect(await search("%")).toHaveLength(1);
    expect(await search("_")).toHaveLength(1);
    expect(await search('"quoted"')).toHaveLength(1);
    expect(await search("OR AND NOT * ( ^")).toHaveLength(0);
  });

  it("reflects edits and deletes", async () => {
    const [s] = (await list("?q=kube")).sparks;
    await app.server.inject({ method: "PUT", url: `/api/sparks/${s!.id}`, payload: { blurb: "nomad" } });
    expect(await search("kube")).toHaveLength(0);
    expect(await search("nomad")).toHaveLength(1);
    await app.server.inject({ method: "DELETE", url: `/api/sparks/${s!.id}` });
    expect(await search("nomad")).toHaveLength(0);
  });
});

describe("images", () => {
  const files = () => [
    ...fs.readdirSync(path.join(dataDir, "images")),
    ...fs.readdirSync(path.join(dataDir, "thumbs")),
  ];

  it("uploads, attaches, serves, detaches and deletes images", async () => {
    const img1 = await upload(await png(40, 20));
    const img2 = await upload(await png(10, 10));
    expect(img1).toMatchObject({ mime: "image/png", width: 40, height: 20 });

    const spark = await create({ blurb: null, imageIds: [img2.id, img1.id] });
    expect(spark.images.map((i) => i.id)).toEqual([img2.id, img1.id]);

    const orig = await app.server.inject({ method: "GET", url: `/files/${img1.id}` });
    expect(orig.headers["content-type"]).toBe("image/png");
    const thumb = await app.server.inject({ method: "GET", url: `/files/${img1.id}/thumb` });
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(files()).toHaveLength(4);

    // Removing an image from the spark deletes it.
    await app.server.inject({ method: "PUT", url: `/api/sparks/${spark.id}`, payload: { imageIds: [img1.id] } });
    expect(files()).toHaveLength(2);
    expect((await app.server.inject({ method: "GET", url: `/files/${img2.id}` })).statusCode).toBe(404);

    await app.server.inject({ method: "DELETE", url: `/api/sparks/${spark.id}` });
    expect(files()).toHaveLength(0);
  });

  it("won't attach another spark's image", async () => {
    const img = await upload(await png());
    await create({ blurb: "owner", imageIds: [img.id] });
    const res = await app.server.inject({ method: "POST", url: "/api/sparks", payload: { imageIds: [img.id] } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-images", async () => {
    for (const value of ["hello", '<svg xmlns="http://www.w3.org/2000/svg"/>']) {
      const res = await app.server.inject({
        method: "POST",
        url: "/api/images",
        ...multipartBody([{ name: "file", value, filename: "x.svg", type: "image/svg+xml" }]),
      });
      expect(res.statusCode).toBe(415);
    }
  });

  it("cleans up abandoned pending uploads", async () => {
    const pending = await upload(await png());
    const attached = await upload(await png());
    await create({ imageIds: [attached.id] });
    expect(await app.cleanupPendingImages(Date.now())).toBe(0); // too new
    expect(await app.cleanupPendingImages(Date.now() + 25 * 3600 * 1000)).toBe(1);
    expect((await app.server.inject({ method: "GET", url: `/files/${pending.id}` })).statusCode).toBe(404);
    expect((await app.server.inject({ method: "GET", url: `/files/${attached.id}` })).statusCode).toBe(200);
  });
});

describe("share target", () => {
  it("stages shared content and redirects to the composer", async () => {
    const res = await app.server.inject({
      method: "POST",
      url: "/share",
      ...multipartBody([
        { name: "title", value: "Cool post" },
        { name: "text", value: "Cool post https://example.com/x" },
        { name: "url", value: "https://example.com/x" },
        { name: "images", value: await png(), filename: "s.png", type: "image/png" },
        { name: "images", value: "not an image", filename: "bad.png", type: "image/png" },
      ]),
    });
    expect(res.statusCode).toBe(303);
    const location = res.headers.location as string;
    expect(location.startsWith("/#")).toBe(true);
    const params = new URLSearchParams(location.slice(2));
    expect(params.get("text")).toBe("Cool post https://example.com/x");
    expect(params.get("images")?.split(",")).toHaveLength(1);
  });

  it("composes shared text", () => {
    expect(composeSharedText("T", "", "https://u")).toBe("T\nhttps://u");
    expect(composeSharedText(undefined, "hi https://u", "https://u")).toBe("hi https://u");
    expect(composeSharedText("same", "same", undefined)).toBe("same");
  });
});
