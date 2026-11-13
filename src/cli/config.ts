import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CliConfig {
  url: string;
  cert?: string;
  key?: string;
  ca?: string;
}

type Key = keyof CliConfig;
export type Source = "flag" | "env" | "config" | "default";

export interface ResolvedConfig extends CliConfig {
  /** Where each setting came from (unset settings are omitted). */
  sources: Partial<Record<Key, Source>>;
  configFile: string;
  configFileExists: boolean;
}

export const DEFAULT_URL = "http://127.0.0.1:3000";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return env.WCSPARK_CONFIG || join(base, "wcspark", "config.json");
}

const expandHome = (p: string) =>
  p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);

/** Precedence: command-line flags, then WCSPARK_* env vars, then the config file, then defaults. */
export function loadConfig(flags: Partial<CliConfig>, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const configFile = configPath(env);
  const configFileExists = existsSync(configFile);
  let file: Partial<CliConfig> = {};
  if (configFileExists) {
    try {
      file = JSON.parse(readFileSync(configFile, "utf8")) as Partial<CliConfig>;
    } catch (err) {
      throw new Error(`Could not read ${configFile}: ${(err as Error).message}`, { cause: err });
    }
  }

  const sources: ResolvedConfig["sources"] = {};
  const pick = (k: Key): string | undefined => {
    const candidates: [string | undefined, Source][] = [
      [flags[k], "flag"],
      [env[`WCSPARK_${k.toUpperCase()}`], "env"],
      [typeof file[k] === "string" ? file[k] : undefined, "config"],
    ];
    for (const [value, source] of candidates) {
      if (value) {
        sources[k] = source;
        return value;
      }
    }
    return undefined;
  };

  const url = pick("url");
  if (!url) sources.url = "default";
  const cert = pick("cert");
  const key = pick("key");
  const ca = pick("ca");
  if (Boolean(cert) !== Boolean(key)) {
    throw new Error("The client certificate and key must be configured together (cert + key)");
  }
  return {
    url: (url ?? DEFAULT_URL).replace(/\/+$/, ""),
    cert: cert && expandHome(cert),
    key: key && expandHome(key),
    ca: ca && expandHome(ca),
    sources,
    configFile,
    configFileExists,
  };
}
