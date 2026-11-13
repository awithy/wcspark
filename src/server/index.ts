import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ dataDir: config.dataDir, logger: true });
const log = app.server.log;

const sweep = () =>
  app.cleanupPendingImages().then(
    (n) => n && log.info(`removed ${n} abandoned pending image(s)`),
    (err) => log.error(err, "pending image cleanup failed"),
  );
await sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info(`${signal} received, shutting down`);
    app.close().then(() => process.exit(0));
  });
}

log.info(`data directory: ${config.dataDir}`);
await app.server.listen({ host: config.host, port: config.port });
