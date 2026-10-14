import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseDataDirEnvValue, resolveProdDataDir } from "@bb/config/runtime";
import {
  formatClientConfigPath,
  normalizeClientServerOrigin,
  parseClientConfig,
} from "@bb/config/client-config";
import { mutateManagedJsonFile } from "@bb/config/managed-json-file";

function configPath(): string {
  const homeDir = homedir();
  const configured = process.env.BB_DATA_DIR;
  return formatClientConfigPath(
    configured === undefined || configured.trim().length === 0
      ? resolveProdDataDir({ homeDir })
      : parseDataDirEnvValue({ homeDir, rawDataDir: configured }),
  );
}

function readConfig() {
  try {
    return parseClientConfig(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return parseClientConfig({});
    throw error;
  }
}

export function resolveCliAuthToken(serverUrl: string): string | undefined {
  return (
    process.env.BB_TOKEN?.trim() ||
    readConfig().servers[normalizeClientServerOrigin(serverUrl)]?.authToken
  );
}

export async function storeCliAuthToken(
  serverUrl: string,
  token: string | null,
): Promise<void> {
  const origin = normalizeClientServerOrigin(serverUrl);
  await mutateManagedJsonFile({
    path: configPath(),
    read: async () => readConfig(),
    mutate: (config) => {
      const profile = config.servers[origin] ?? { hosts: {} };
      if (token === null) delete profile.authToken;
      else profile.authToken = token;
      config.servers[origin] = profile;
      return config;
    },
  });
}
