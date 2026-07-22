import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readPositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readableFile(value, name) {
  if (!value) return undefined;
  const path = resolve(value);
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`${name} is not readable: ${path}`);
  }
  return path;
}

export function loadConfig(env = process.env) {
  const tlsCertFile = readableFile(env.TLS_CERT_FILE, "TLS_CERT_FILE");
  const tlsKeyFile = readableFile(env.TLS_KEY_FILE, "TLS_KEY_FILE");
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  }

  return {
    host: env.HOST || "0.0.0.0",
    port: readPositiveInteger(env.PORT, tlsCertFile ? 8443 : 8080, "PORT"),
    publicDir: resolve(env.PUBLIC_DIR || fileURLToPath(new URL("../public", import.meta.url))),
    phoneBaseUrl: env.PHONE_BASE_URL || null,
    tlsCertFile,
    tlsKeyFile,
    maxPayloadBytes: readPositiveInteger(env.WS_MAX_PAYLOAD_BYTES, 1024 * 1024, "WS_MAX_PAYLOAD_BYTES"),
    maxBufferedBytes: readPositiveInteger(env.WS_MAX_BUFFERED_BYTES, 1024 * 1024, "WS_MAX_BUFFERED_BYTES"),
    helloTimeoutMs: readPositiveInteger(env.WS_HELLO_TIMEOUT_MS, 5_000, "WS_HELLO_TIMEOUT_MS"),
    heartbeatIntervalMs: readPositiveInteger(env.WS_HEARTBEAT_INTERVAL_MS, 15_000, "WS_HEARTBEAT_INTERVAL_MS"),
  };
}
