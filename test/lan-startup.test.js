import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLanIpv4,
  phoneBaseUrlForIp,
  prepareLanEnvironment,
} from "../server/lan-startup.js";

const iface = (address, overrides = {}) => ({
  address,
  family: "IPv4",
  internal: false,
  ...overrides,
});

test("detectLanIpv4 prefers a private physical interface", () => {
  assert.deepEqual(detectLanIpv4({
    interfaces: {
      utun4: [iface("10.8.0.2")],
      en0: [iface("192.168.178.26")],
      loopback: [iface("127.0.0.1", { internal: true })],
    },
  }), {
    address: "192.168.178.26",
    interfaceName: "en0",
  });
});

test("detectLanIpv4 accepts an explicit LAN_IP override", () => {
  assert.deepEqual(detectLanIpv4({ interfaces: {}, override: "10.20.30.40" }), {
    address: "10.20.30.40",
    interfaceName: "LAN_IP override",
  });
  assert.throws(
    () => detectLanIpv4({ interfaces: {}, override: "127.0.0.1" }),
    /LAN_IP must be a usable IPv4 address/,
  );
});

test("phoneBaseUrlForIp preserves the configured protocol, port, and path", () => {
  assert.equal(
    phoneBaseUrlForIp("https://192.168.1.50:9443/cafe", "192.168.178.26"),
    "https://192.168.178.26:9443/cafe",
  );
  assert.equal(phoneBaseUrlForIp(null, "192.168.178.26", 8443), "https://192.168.178.26:8443");
});

test("prepareLanEnvironment is inert unless AUTO_LAN_IP is enabled", () => {
  const env = { PHONE_BASE_URL: "https://manual.example:8443" };
  assert.equal(prepareLanEnvironment(env), env);
});

test("prepareLanEnvironment refreshes a stale certificate and returns runtime overrides", () => {
  const generated = [];
  const messages = [];
  const prepared = prepareLanEnvironment({
    AUTO_LAN_IP: "true",
    PORT: "8443",
    PHONE_BASE_URL: "https://192.168.1.50:8443",
    TLS_CERT_FILE: "./certs/camera-local.pem",
    TLS_KEY_FILE: "./certs/camera-local-key.pem",
  }, {
    interfaces: { Ethernet: [iface("192.168.178.26")] },
    certificateReady: () => false,
    generateCertificate: (options) => generated.push(options),
    logger: { info: (message) => messages.push(message) },
  });

  assert.equal(prepared.HOST, "0.0.0.0");
  assert.equal(prepared.PHONE_BASE_URL, "https://192.168.178.26:8443");
  assert.deepEqual(generated, [{
    certFile: "./certs/camera-local.pem",
    keyFile: "./certs/camera-local-key.pem",
    ip: "192.168.178.26",
  }]);
  assert.match(messages.join("\n"), /refreshing HTTPS certificate/);
  assert.match(messages.join("\n"), /using LAN IPv4 192\.168\.178\.26 from Ethernet/);
});

test("prepareLanEnvironment reuses a certificate that already covers the IP", () => {
  let generated = false;
  const prepared = prepareLanEnvironment({ AUTO_LAN_IP: "1" }, {
    interfaces: { en0: [iface("192.168.178.26")] },
    certificateReady: () => true,
    generateCertificate: () => { generated = true; },
    logger: { info() {} },
  });

  assert.equal(generated, false);
  assert.equal(prepared.TLS_CERT_FILE, "./certs/camera-local.pem");
  assert.equal(prepared.TLS_KEY_FILE, "./certs/camera-local-key.pem");
});
