import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VIRTUAL_INTERFACE = /(bridge|docker|hamachi|tailscale|tap|tun|utun|vbox|veth|vmnet|vpn|zerotier)/i;
const PHYSICAL_INTERFACE = /^(en\d+|enp\w+|ens\w+|eth\w*|ethernet|wi-?fi|wlan\w*)/i;

function readBoolean(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function isUsableIpv4(address) {
  return isIP(address) === 4
    && !address.startsWith("127.")
    && !address.startsWith("169.254.")
    && address !== "0.0.0.0";
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function interfaceScore(name, address) {
  let score = isPrivateIpv4(address) ? 100 : 0;
  if (PHYSICAL_INTERFACE.test(name)) score += 30;
  if (VIRTUAL_INTERFACE.test(name)) score -= 200;
  return score;
}

export function detectLanIpv4({ interfaces = networkInterfaces(), override } = {}) {
  if (override) {
    if (!isUsableIpv4(override)) {
      throw new Error(`LAN_IP must be a usable IPv4 address; received ${override}`);
    }
    return { address: override, interfaceName: "LAN_IP override" };
  }

  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = entry.family === 4 ? "IPv4" : entry.family;
      if (family !== "IPv4" || entry.internal || !isUsableIpv4(entry.address)) continue;
      candidates.push({
        address: entry.address,
        interfaceName: name,
        score: interfaceScore(name, entry.address),
      });
    }
  }

  candidates.sort((left, right) => (
    right.score - left.score
    || left.interfaceName.localeCompare(right.interfaceName)
    || left.address.localeCompare(right.address)
  ));
  if (!candidates.length) {
    throw new Error("AUTO_LAN_IP could not find a usable LAN IPv4 address; set LAN_IP explicitly");
  }
  const { address, interfaceName } = candidates[0];
  return { address, interfaceName };
}

export function phoneBaseUrlForIp(existingValue, ip, port = 8443) {
  if (existingValue) {
    try {
      const url = new URL(existingValue);
      url.hostname = ip;
      return url.toString().replace(/\/$/, "");
    } catch {
      throw new Error(`PHONE_BASE_URL must be an absolute URL; received ${existingValue}`);
    }
  }
  return `https://${ip}:${port}`;
}

export function certificateIsReady(certFile, keyFile, ip, now = Date.now()) {
  if (!existsSync(certFile) || !existsSync(keyFile)) return false;
  try {
    const certificate = new X509Certificate(readFileSync(certFile));
    if (certificate.checkIP(ip) !== ip) return false;
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) return false;

    const certificatePublicKey = certificate.publicKey.export({ format: "der", type: "spki" });
    const privateKeyPublicKey = createPublicKey(createPrivateKey(readFileSync(keyFile)))
      .export({ format: "der", type: "spki" });
    return certificatePublicKey.equals(privateKeyPublicKey);
  } catch {
    return false;
  }
}

export function generateMkcertCertificate({ certFile, keyFile, ip }) {
  const resolvedCertFile = resolve(certFile);
  const resolvedKeyFile = resolve(keyFile);
  mkdirSync(dirname(resolvedCertFile), { recursive: true });
  mkdirSync(dirname(resolvedKeyFile), { recursive: true });

  const result = spawnSync("mkcert", [
    "-cert-file",
    resolvedCertFile,
    "-key-file",
    resolvedKeyFile,
    ip,
    "localhost",
    "127.0.0.1",
    "::1",
  ], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error("AUTO_LAN_IP needs mkcert to refresh the HTTPS certificate, but mkcert is not installed");
  }
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new Error(`mkcert could not refresh the HTTPS certificate: ${detail}`);
  }
}

export function prepareLanEnvironment(env = process.env, {
  interfaces,
  certificateReady = certificateIsReady,
  generateCertificate = generateMkcertCertificate,
  logger = console,
} = {}) {
  if (!readBoolean(env.AUTO_LAN_IP, false, "AUTO_LAN_IP")) return env;

  const { address: ip, interfaceName } = detectLanIpv4({
    interfaces: interfaces ?? networkInterfaces(),
    override: env.LAN_IP?.trim(),
  });
  const certFile = env.TLS_CERT_FILE || "./certs/camera-local.pem";
  const keyFile = env.TLS_KEY_FILE || "./certs/camera-local-key.pem";
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  }

  if (!certificateReady(resolve(certFile), resolve(keyFile), ip)) {
    logger.info?.(`[startup] refreshing HTTPS certificate for ${ip}`);
    generateCertificate({ certFile, keyFile, ip });
  }
  logger.info?.(`[startup] using LAN IPv4 ${ip} from ${interfaceName}`);

  return {
    ...env,
    HOST: env.HOST || "0.0.0.0",
    PHONE_BASE_URL: phoneBaseUrlForIp(env.PHONE_BASE_URL, ip, env.PORT || 8443),
    TLS_CERT_FILE: certFile,
    TLS_KEY_FILE: keyFile,
  };
}
