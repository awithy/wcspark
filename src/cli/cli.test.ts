import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import type { Spark } from "../shared/types.js";
import { loadConfig } from "./config.js";
import { parseDay, parseWhen } from "./when.js";

// ---- unit ------------------------------------------------------------------------

describe("parseWhen", () => {
  const now = new Date(2026, 10, 13, 15, 30); // Fri 13 Nov 2026, local time

  it("handles named days", () => {
    expect(parseWhen("today", "start", now)).toBe(new Date(2026, 10, 13).getTime());
    expect(parseWhen("today", "end", now)).toBe(new Date(2026, 10, 14).getTime());
    expect(parseWhen("yesterday", "start", now)).toBe(new Date(2026, 10, 12).getTime());
    expect(parseDay("fri", now)?.start).toBe(new Date(2026, 10, 13).getTime());
    expect(parseDay("Tuesday", now)?.start).toBe(new Date(2026, 10, 10).getTime());
    expect(parseDay("sat", now)?.start).toBe(new Date(2026, 10, 7).getTime());
    expect(parseWhen("2026-11-10", "end", now)).toBe(new Date(2026, 10, 11).getTime());
  });

  it("handles relative ages, local times, and ISO timestamps", () => {
    expect(parseWhen("7d", "start", now)).toBe(now.getTime() - 7 * 86_400_000);
    expect(parseWhen("-12h", "start", now)).toBe(now.getTime() - 12 * 3_600_000);
    expect(parseWhen("2 weeks ago", "start", now)).toBe(now.getTime() - 14 * 86_400_000);
    expect(parseWhen("30m", "start", now)).toBe(now.getTime() - 30 * 60_000);
    expect(parseWhen("2026-11-01 09:15", "start", now)).toBe(new Date(2026, 10, 1, 9, 15).getTime());
    expect(parseWhen("2026-11-01T09:15:00Z", "start", now)).toBe(Date.UTC(2026, 10, 1, 9, 15));
  });

  it("rejects nonsense", () => {
    expect(() => parseWhen("next tuesday", "start", now)).toThrow(/Unrecognised/);
    expect(() => parseWhen("2026-02-30", "start", now)).toThrow(/Invalid date/);
  });
});

describe("loadConfig", () => {
  it("prefers flags, then env, then the config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wcspark-cfg-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ url: "https://file.example/", cert: "~/c.pem", key: "/k.pem" }));
    const env = { WCSPARK_CONFIG: file, WCSPARK_URL: "https://env.example" };

    const fromEnv = loadConfig({}, env);
    expect(fromEnv.url).toBe("https://env.example");
    expect(fromEnv.cert).toBe(path.join(os.homedir(), "c.pem"));
    expect(fromEnv.sources).toEqual({ url: "env", cert: "config", key: "config" });
    expect(loadConfig({ url: "http://flag:1/" }, env).url).toBe("http://flag:1");
    expect(loadConfig({}, { WCSPARK_CONFIG: file }).url).toBe("https://file.example");
    expect(loadConfig({}, { WCSPARK_CONFIG: path.join(dir, "missing.json") })).toMatchObject({
      url: "http://127.0.0.1:3000",
      configFileExists: false,
    });
    expect(() => loadConfig({ cert: "/c.pem" }, { WCSPARK_CONFIG: path.join(dir, "missing.json") })).toThrow(
      /together/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---- end to end: the bundled CLI against a real server --------------------------------

let tmp: string;
let bin: string;
let app: App;
let baseUrl: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wcspark-cli-"));
  bin = path.join(tmp, "wcspark.mjs");
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bin,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: "silent",
  });
  app = await buildApp({ dataDir: path.join(tmp, "data"), clientDir: path.join(tmp, "no-client") });
  await app.server.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: tmp,
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        NO_COLOR: "1",
        WCSPARK_CONFIG: path.join(tmp, "no-config.json"),
        WCSPARK_URL: baseUrl,
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

async function ok(args: string[], input?: string): Promise<string> {
  const res = await run(args, { input });
  expect(res.code, res.stderr).toBe(0);
  return res.stdout;
}

const json = async <T = Spark>(args: string[], input?: string): Promise<T> =>
  JSON.parse(await ok([...args, "--json"], input)) as T;

const png = (width = 30, height = 20) =>
  sharp({ create: { width, height, channels: 3, background: "#08f" } }).png().toBuffer();

describe("wcspark CLI", () => {
  let img1: string;
  let img2: string;

  beforeAll(async () => {
    img1 = path.join(tmp, "one.png");
    img2 = path.join(tmp, "two.png");
    fs.writeFileSync(img1, await png(30, 20));
    fs.writeFileSync(img2, await png(1200, 600));
  });

  it("adds from words, stdin, and image files", async () => {
    expect((await json(["add", "Look", "into", "smithy.io"])).blurb).toBe("Look into smithy.io");
    expect((await json(["add"], "piped\r\ntext\n")).blurb).toBe("piped\ntext");
    expect((await json(["add", "-"], "  explicit stdin  ")).blurb).toBe("explicit stdin");

    const s = await json(["add", "Two pictures", "-i", img1, img2]);
    expect(s.blurb).toBe("Two pictures");
    expect(s.images.map((i) => [i.width, i.height])).toEqual([[30, 20], [1200, 600]]);
    expect((s.images[0] as { url?: string }).url).toBe(`${baseUrl}/files/${s.images[0]!.id}`);

    const imageOnly = await json(["add", "-i", img1]);
    expect(imageOnly.blurb).toBeNull();

    const human = await run(["add", "--", "-5 degrees: cover plants"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stderr).toContain("Added:");
    expect(human.stdout).toMatch(/^#\d+ {2}\d{4}-\d\d-\d\d \d\d:\d\d\n-5 degrees: cover plants\n$/);
  });

  it("refuses bad input before uploading anything", async () => {
    let res = await run(["add"]);
    expect([res.code, res.stderr]).toEqual([1, expect.stringMatching(/Nothing to add/)]);
    res = await run(["add", "x".repeat(4001)]);
    expect(res.stderr).toMatch(/limit is 4000/);
    res = await run(["add", "hi", "-i", path.join(tmp, "missing.png")]);
    expect(res.stderr).toMatch(/Cannot read image .*missing\.png/);
    fs.writeFileSync(path.join(tmp, "notes.txt"), "not an image");
    res = await run(["add", "hi", "-i", path.join(tmp, "notes.txt")]);
    expect(res.stderr).toMatch(/Uploading notes\.txt failed: Unsupported/);
  });

  it("lists, filters by time, and searches", async () => {
    const all = await json<Spark[]>(["ls", "--all"]);
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.map((s) => s.id)).toEqual([...all.map((s) => s.id)].sort((a, b) => b - a));

    const two = await run(["ls", "-n", "2"]);
    expect(two.stdout.trim().split("\n")).toHaveLength(2);
    expect(two.stderr).toMatch(/Showing the newest 2/);
    expect(two.stdout).toMatch(/\[1 image\]/);

    expect(await json<Spark[]>(["ls", "--on", "today", "--all"])).toHaveLength(all.length);
    expect(await json<Spark[]>(["ls", "--on", "yesterday"])).toHaveLength(0);
    expect(await json<Spark[]>(["ls", "--until", "1h"])).toHaveLength(0);
    expect((await run(["ls", "--since", "soon"])).stderr).toMatch(/Unrecognised time "soon"/);

    expect((await json<Spark[]>(["search", "SMITHY"])).map((s) => s.blurb)).toEqual(["Look into smithy.io"]);
    expect((await json<Spark[]>(["find", "pictures", "two"])).map((s) => s.blurb)).toEqual(["Two pictures"]);
    expect((await run(["search", "zzz-nope"])).stderr).toMatch(/No matching sparks/);
  });

  it("edits only what was asked", async () => {
    const s = await json(["add", "Original", "-i", img1, img2]);
    const [first, second] = s.images;

    let e = await json(["edit", String(s.id), "-a", "more"]);
    expect(e.blurb).toBe("Original\nmore");
    expect(e.images.map((i) => i.id)).toEqual([first!.id, second!.id]);

    e = await json(["edit", `#${s.id}`, "Replaced", "text"]);
    expect(e.blurb).toBe("Replaced text");
    expect(e.images).toHaveLength(2);

    e = await json(["edit", String(s.id), "-r", "1", "-i", img1]);
    expect(e.images.map((i) => i.id)).toEqual([second!.id, expect.any(String)]);
    expect(e.images[1]!.id).not.toBe(first!.id);

    e = await json(["edit", String(s.id), "", "-r", second!.id]);
    expect(e.blurb).toBeNull();
    expect(e.images).toHaveLength(1);

    let res = await run(["edit", String(s.id), "--clear-images"]);
    expect(res.stderr).toMatch(/needs text or at least one image/);
    res = await run(["edit", String(s.id)]);
    expect(res.stderr).toMatch(/Nothing to change/);
    res = await run(["edit", String(s.id), "-r", "5"]);
    expect(res.stderr).toMatch(/has no image "5"/);
    res = await run(["edit", "999999", "-a", "x"]);
    expect(res.stderr).toMatch(/Spark not found/);
  });

  it("shows and downloads images", async () => {
    const s = await json(["add", "Download me", "-i", img1, img2]);

    const shown = await ok(["show", String(s.id)]);
    expect(shown).toContain("Download me");
    expect(shown).toContain(`[2] ${s.images[1]!.id}  png 1200×600  ${baseUrl}/files/${s.images[1]!.id}`);
    expect(await json<Spark[]>(["show", String(s.id), String(s.id)])).toHaveLength(2);

    const dir = path.join(tmp, "dl");
    const paths = (await ok(["download", String(s.id), "-o", dir])).trim().split("\n");
    expect(paths).toEqual(s.images.map((i) => path.join(dir, `${i.id}.png`)));
    expect(fs.readFileSync(paths[0]!)).toEqual(fs.readFileSync(img1));

    const thumb = (await ok(["dl", s.images[1]!.id, "--thumb", "-o", path.join(tmp, "t.webp")])).trim();
    expect((await sharp(thumb).metadata()).format).toBe("webp");
    expect((await sharp(thumb).metadata()).width).toBe(840);

    expect((await run(["download", String(s.id), "-o", "-"])).stderr).toMatch(/exactly one image/);
  });

  it("deletes only with confirmation", async () => {
    const s = await json(["add", "Delete me"]);
    let res = await run(["rm", String(s.id)]);
    expect(res.stderr).toMatch(/Refusing to delete without -y/);
    res = await run(["rm", String(s.id), "999999", "-y"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe(`Deleted #${s.id}\n`);
    expect(res.stderr).toMatch(/#999999: Spark not found/);
    expect((await run(["show", String(s.id)])).stderr).toMatch(/Spark not found/);
  });

  it("exports everything", async () => {
    const dir = path.join(tmp, "export");
    const msg = await ok(["export", dir]);
    const sparks = JSON.parse(fs.readFileSync(path.join(dir, "sparks.json"), "utf8")) as Spark[];
    const imageCount = sparks.reduce((n, s) => n + s.images.length, 0);
    expect(msg).toContain(`Exported ${sparks.length} sparks and ${imageCount} images (${imageCount} downloaded)`);
    expect(fs.readdirSync(path.join(dir, "images"))).toHaveLength(imageCount);
    expect(await ok(["export", dir])).toContain("(0 downloaded)");
  });

  it("reports config and connection errors", async () => {
    const cfg = await json<{ url: string; sources: object }>(["config"]);
    expect(cfg).toMatchObject({ url: baseUrl, sources: { url: "env" } });
    const res = await run(["--url", "http://127.0.0.1:9", "ls"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Could not reach http:\/\/127\.0\.0\.1:9/);
  });
});

// ---- mTLS: a TLS-terminating proxy that demands a client certificate, like production ----

const haveOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveOpenssl)("mTLS", () => {
  let proxy: https.Server;
  let proxyUrl: string;
  let pki: string;
  const pem = (name: string) => path.join(pki, name);

  beforeAll(async () => {
    pki = path.join(tmp, "pki");
    fs.mkdirSync(pki);
    const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: pki, stdio: "pipe" });
    const issue = (name: string, cn: string, ext: string) => {
      ssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key.pem`,
        "-subj", `/CN=${cn}`, "-out", `${name}.csr`);
      fs.writeFileSync(pem(`${name}.ext`), ext);
      ssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.cert.pem", "-CAkey", "ca.key.pem", "-CAcreateserial",
        "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.cert.pem`);
    };
    ssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key.pem",
      "-subj", "/CN=Test CA", "-days", "1", "-out", "ca.cert.pem");
    issue("server", "localhost", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    issue("client", "test-client", "extendedKeyUsage=clientAuth\n");

    const target = new URL(baseUrl);
    proxy = https.createServer(
      {
        key: fs.readFileSync(pem("server.key.pem")),
        cert: fs.readFileSync(pem("server.cert.pem")),
        ca: fs.readFileSync(pem("ca.cert.pem")),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const upstream = http.request(
          { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        req.pipe(upstream);
      },
    );
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(() => new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r())));

  const env = () => ({ WCSPARK_URL: proxyUrl, WCSPARK_CA: pem("ca.cert.pem") });
  const withCert = () => ({ ...env(), WCSPARK_CERT: pem("client.cert.pem"), WCSPARK_KEY: pem("client.key.pem") });

  it("works with the client certificate, including uploads", async () => {
    const add = await run(["add", "over mTLS", "-i", path.join(tmp, "one.png"), "--json"], { env: withCert() });
    expect(add.code, add.stderr).toBe(0);
    const spark = JSON.parse(add.stdout) as Spark;
    expect(spark.images).toHaveLength(1);
    const found = await run(["search", "over mtls", "--json"], { env: withCert() });
    expect((JSON.parse(found.stdout) as Spark[]).map((s) => s.id)).toEqual([spark.id]);
  });

  it("explains a missing client certificate", async () => {
    const res = await run(["ls"], { env: env() });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Could not reach https:\/\/127\.0\.0\.1:\d+/);
    expect(res.stderr).toMatch(/requires a client certificate/);
  });

  it("rejects an untrusted server certificate", async () => {
    const { WCSPARK_CA: _, ...noCa } = withCert();
    const res = await run(["ls"], { env: noCa });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/self.signed|unable to (get|verify)/i);
  });
});
