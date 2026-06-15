export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const defaultLevel = process.env.VITEST ? "error" : "debug";
const configuredLevel = (
  process.env.XCODECLOUD_MCP_LOG_LEVEL ??
  process.env.TESTFLIGHT_MCP_LOG_LEVEL ??
  defaultLevel
).toLowerCase() as LogLevel;
const minimumLevel = LEVEL_PRIORITY[configuredLevel] === undefined ? "debug" : configuredLevel;

function redactValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (/key|token|authorization|private|secret|issuer/i.test(key)) {
    if (typeof value === "string" && value.length > 0) {
      return `${value.slice(0, 4)}...redacted`;
    }
    return "redacted";
  }
  return value;
}

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, redactValue(key, value)]),
  );
}

export function log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "xcodecloud-mcp",
    message,
    ...redactMeta(meta),
  };

  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function logError(message: string, error: unknown, meta: Record<string, unknown> = {}): void {
  const errorMeta =
    error instanceof Error
      ? {
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
        }
      : { errorMessage: String(error) };

  log("error", message, { ...meta, ...errorMeta });
}
