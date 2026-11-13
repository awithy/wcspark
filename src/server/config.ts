import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    dataDir: path.resolve(env.DATA_DIR ?? "data"),
  };
}
