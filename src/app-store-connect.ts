import { SignJWT, importPKCS8 } from "jose";
import type { AppStoreConnectConfig } from "./config.js";
import { log } from "./logger.js";

const API_BASE_URL = "https://api.appstoreconnect.apple.com/v1";

type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  path: string;
  query?: Record<string, QueryValue | QueryValue[]>;
}

export interface MutatingRequestOptions extends RequestOptions {
  body: unknown;
}

export interface AppStoreConnectClientOptions {
  fetch?: typeof fetch;
  tokenProvider?: () => Promise<string>;
}

export class AppStoreConnectClient {
  private token?: { value: string; expiresAtMs: number };
  private hasLoggedSuccessfulAuthentication = false;
  private readonly fetch: typeof fetch;
  private readonly tokenProvider?: () => Promise<string>;

  constructor(
    private readonly config: AppStoreConnectConfig,
    options: AppStoreConnectClientOptions = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.tokenProvider = options.tokenProvider;
  }

  async get<T>({ path, query }: RequestOptions): Promise<T> {
    return this.request<T>("GET", { path, query });
  }

  async post<T>({ path, query, body }: MutatingRequestOptions): Promise<T> {
    return this.request<T>("POST", { path, query, body });
  }

  private async request<T>(method: "GET" | "POST", { path, query, body }: RequestOptions & { body?: unknown }): Promise<T> {
    const token = await this.getToken();
    const url = new URL(`${API_BASE_URL}${path}`);
    const startedAt = Date.now();

    for (const [key, value] of Object.entries(query ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && String(item).trim().length > 0) url.searchParams.append(key, String(item));
        }
      } else if (value !== undefined && String(value).trim().length > 0) {
        url.searchParams.set(key, String(value));
      }
    }

    log("debug", "app_store_connect_request_started", {
      method,
      path,
      query: url.searchParams.toString(),
      hasBody: body !== undefined,
    });

    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      log("error", "app_store_connect_request_failed", {
        method,
        path,
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    log(response.ok ? "debug" : "warn", "app_store_connect_request_completed", {
      method,
      path,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - startedAt,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`App Store Connect request failed: ${response.status} ${response.statusText}\n${body}`);
    }

    if (!this.hasLoggedSuccessfulAuthentication) {
      this.hasLoggedSuccessfulAuthentication = true;
      log("info", "app_store_connect_login_successful", {
        keyId: this.config.keyId,
        issuerId: this.config.issuerId,
      });
    }

    return (await response.json()) as T;
  }

  private async getToken(): Promise<string> {
    if (this.tokenProvider) {
      return this.tokenProvider();
    }

    const now = Date.now();
    if (this.token && this.token.expiresAtMs - now > 60_000) {
      log("debug", "app_store_connect_token_reused", {
        expiresInMs: this.token.expiresAtMs - now,
      });
      return this.token.value;
    }

    log("debug", "app_store_connect_token_created", {
      keyId: this.config.keyId,
      issuerId: this.config.issuerId,
    });

    const privateKey = await importPKCS8(this.config.privateKey, "ES256");
    const expiresAtSeconds = Math.floor(now / 1000) + 20 * 60;
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId, typ: "JWT" })
      .setIssuer(this.config.issuerId)
      .setAudience("appstoreconnect-v1")
      .setExpirationTime(expiresAtSeconds)
      .sign(privateKey);

    this.token = { value, expiresAtMs: expiresAtSeconds * 1000 };
    return value;
  }
}
