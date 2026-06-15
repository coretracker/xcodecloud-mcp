import { readFileSync } from "node:fs";

export interface AppStoreConnectConfig {
  issuerId: string;
  keyId: string;
  privateKey: string;
}

export interface ServerConfig {
  appStoreConnect: AppStoreConnectConfig;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readPrivateKey(): string {
  const inlineKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY;
  if (inlineKey && inlineKey.trim().length > 0) {
    return inlineKey.replace(/\\n/g, "\n");
  }

  const keyPath = process.env.APP_STORE_CONNECT_PRIVATE_KEY_PATH;
  if (keyPath && keyPath.trim().length > 0) {
    return readFileSync(keyPath, "utf8");
  }

  throw new Error(
    "Missing App Store Connect private key. Set APP_STORE_CONNECT_PRIVATE_KEY or APP_STORE_CONNECT_PRIVATE_KEY_PATH.",
  );
}

export function loadConfig(): ServerConfig {
  return {
    appStoreConnect: {
      issuerId: requireEnv("APP_STORE_CONNECT_ISSUER_ID"),
      keyId: requireEnv("APP_STORE_CONNECT_KEY_ID"),
      privateKey: readPrivateKey(),
    },
  };
}
