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

function readBoolean(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
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
  const host = env.HOST || (tlsCertFile ? "0.0.0.0" : "127.0.0.1");
  if (!tlsCertFile && host !== "127.0.0.1") {
    throw new Error("HOST must be 127.0.0.1 when TLS is disabled; plaintext must remain loopback-only");
  }
  const localHttpExplicit = Boolean(env.LOCAL_HTTP_PORT || env.LOCAL_HTTP_HOST);
  const localHttpEnabled = readBoolean(
    env.LOCAL_HTTP_ENABLED,
    Boolean(tlsCertFile) || localHttpExplicit,
    "LOCAL_HTTP_ENABLED",
  );
  const localHttpHost = env.LOCAL_HTTP_HOST || "127.0.0.1";
  if (localHttpHost !== "127.0.0.1") {
    throw new Error("LOCAL_HTTP_HOST must be 127.0.0.1; plaintext must remain loopback-only");
  }

  return {
    host,
    port: readPositiveInteger(env.PORT, tlsCertFile ? 8443 : 8080, "PORT"),
    publicDir: resolve(env.PUBLIC_DIR || fileURLToPath(new URL("../public", import.meta.url))),
    phoneBaseUrl: env.PHONE_BASE_URL || null,
    tlsCertFile,
    tlsKeyFile,
    localHttpEnabled,
    localHttpHost,
    localHttpPort: readPositiveInteger(env.LOCAL_HTTP_PORT, 8080, "LOCAL_HTTP_PORT"),
    maxPayloadBytes: readPositiveInteger(env.WS_MAX_PAYLOAD_BYTES, 1024 * 1024, "WS_MAX_PAYLOAD_BYTES"),
    maxBufferedBytes: readPositiveInteger(env.WS_MAX_BUFFERED_BYTES, 1024 * 1024, "WS_MAX_BUFFERED_BYTES"),
    helloTimeoutMs: readPositiveInteger(env.WS_HELLO_TIMEOUT_MS, 5_000, "WS_HELLO_TIMEOUT_MS"),
    heartbeatIntervalMs: readPositiveInteger(env.WS_HEARTBEAT_INTERVAL_MS, 15_000, "WS_HEARTBEAT_INTERVAL_MS"),
  };
}
