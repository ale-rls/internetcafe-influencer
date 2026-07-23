import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../server/config.js";
import { createInternetCafeServer } from "../server/index.js";

const QUIET_LOGGER = { info() {}, warn() {} };

async function startRuntime(t, overrides = {}) {
  const runtime = createInternetCafeServer({
    host: "127.0.0.1",
    port: 0,
    publicDir: new URL("../public", import.meta.url).pathname,
    phoneBaseUrl: "https://cafe.example/kiosk",
    maxPayloadBytes: 1024 * 1024,
    maxBufferedBytes: 1024 * 1024,
    helloTimeoutMs: 2_000,
    heartbeatIntervalMs: 60_000,
    ...overrides,
  }, { logger: QUIET_LOGGER });
  const address = await runtime.start();
  t.after(() => runtime.close());
  return { runtime, baseUrl: `http://127.0.0.1:${address.port}` };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
  });
}

async function connectRole(baseUrl, role, seat = 1) {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/stream`);
  await once(socket, "open");
  const acknowledgement = nextMessage(socket);
  socket.send(JSON.stringify({ type: "hello", role, seat }));
  const { data, isBinary } = await acknowledgement;
  assert.equal(isBinary, false);
  assert.deepEqual(JSON.parse(data.toString()), { type: "hello-ack", role, seat: String(seat) });
  return socket;
}

test("HTTP routes expose health, QR, static phone content, and expected redirects", async (t) => {
  const { baseUrl } = await startRuntime(t);

  const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/qr/?seat=1");

  const phoneRedirect = await fetch(`${baseUrl}/phone?seat=1`, { redirect: "manual" });
  assert.equal(phoneRedirect.status, 308);
  assert.equal(phoneRedirect.headers.get("location"), "/phone/?seat=1");

  const phone = await fetch(`${baseUrl}/phone/?seat=1`);
  assert.equal(phone.status, 200);
  assert.match(phone.headers.get("content-type"), /^text\/html/);

  const qr = await fetch(`${baseUrl}/qr/?seat=1`);
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /https:\/\/cafe\.example\/kiosk\/phone\/\?seat=1/);

  const qrcode = await fetch(`${baseUrl}/qrcode`);
  assert.equal(qrcode.status, 200);
  assert.match(await qrcode.text(), /https:\/\/cafe\.example\/kiosk\/phone\/\?seat=1/);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.ok(Number.isInteger(healthBody.uptimeSeconds));
  assert.ok(healthBody.uptimeSeconds >= 0);
  delete healthBody.uptimeSeconds;
  assert.deepEqual(healthBody, {
    ok: true,
    status: "running",
    transport: "http/ws",
    localHttp: { enabled: false },
    phoneBaseUrl: "https://cafe.example/kiosk",
    websocketPaths: ["/", "/stream"],
    connections: 0,
    registeredConnections: 0,
    seats: {},
    counters: {
      receivedFrames: 0,
      receivedBytes: 0,
      forwardedFrames: 0,
      forwardedBytes: 0,
      droppedNoDestination: 0,
      droppedBackpressure: 0,
      rejectedMessages: 0,
      replacedConnections: 0,
    },
  });
});

test("WebSocket clients route one-seat frames and replace an older matching role", async (t) => {
  const { runtime, baseUrl } = await startRuntime(t);
  const decoder = await connectRole(baseUrl, "decoder");
  const phone = await connectRole(baseUrl, "phone");
  const touchOutput = await connectRole(baseUrl, "touch-output");
  t.after(() => {
    decoder.close();
    phone.close();
    touchOutput.close();
  });

  const toDecoder = nextMessage(decoder);
  phone.send(Buffer.from("camera-jpeg"));
  const decoderFrame = await toDecoder;
  assert.equal(decoderFrame.isBinary, true);
  assert.equal(decoderFrame.data.toString(), "camera-jpeg");

  const toPhone = nextMessage(phone);
  touchOutput.send(Buffer.from("touchdesigner-jpeg"));
  const phoneFrame = await toPhone;
  assert.equal(phoneFrame.isBinary, true);
  assert.equal(phoneFrame.data.toString(), "touchdesigner-jpeg");

  const previousClosed = once(phone, "close");
  const replacement = await connectRole(baseUrl, "phone");
  t.after(() => replacement.close());
  const [code] = await previousClosed;
  assert.equal(code, 4001);

  const health = await (await fetch(`${baseUrl}/healthz`)).json();
  assert.equal(health.registeredConnections, 3);
  assert.deepEqual(health.seats["1"], { phone: true, decoder: true, "touch-output": true });
  assert.equal(runtime.router.snapshot().counters.replacedConnections, 1);
});

test("TLS configuration enables a loopback-only TouchDesigner listener by default", () => {
  const config = loadConfig({
    TLS_CERT_FILE: process.execPath,
    TLS_KEY_FILE: process.execPath,
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8443);
  assert.equal(config.localHttpEnabled, true);
  assert.equal(config.localHttpHost, "127.0.0.1");
  assert.equal(config.localHttpPort, 8080);

  assert.throws(
    () => loadConfig({ LOCAL_HTTP_ENABLED: "true", LOCAL_HTTP_HOST: "0.0.0.0" }),
    /loopback-only/,
  );
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0" }),
    /plaintext must remain loopback-only/,
  );
});

test("primary and local listeners share WebSocket routing and shutdown", async (t) => {
  const { runtime, baseUrl } = await startRuntime(t, {
    localHttpEnabled: true,
    localHttpHost: "127.0.0.1",
    localHttpPort: 0,
  });
  const localAddress = runtime.localServer.address();
  assert.equal(localAddress.address, "127.0.0.1");
  const localBaseUrl = `http://127.0.0.1:${localAddress.port}`;

  const decoder = await connectRole(localBaseUrl, "decoder");
  const phone = await connectRole(baseUrl, "phone");
  const touchOutput = await connectRole(localBaseUrl, "touch-output");
  t.after(() => {
    decoder.close();
    phone.close();
    touchOutput.close();
  });

  const toDecoder = nextMessage(decoder);
  phone.send(Buffer.from("phone-over-primary"));
  assert.equal((await toDecoder).data.toString(), "phone-over-primary");

  const toPhone = nextMessage(phone);
  touchOutput.send(Buffer.from("touch-over-loopback"));
  assert.equal((await toPhone).data.toString(), "touch-over-loopback");

  const localHealth = await (await fetch(`${localBaseUrl}/healthz`)).json();
  assert.deepEqual(localHealth.localHttp, {
    enabled: true,
    host: "127.0.0.1",
    port: localAddress.port,
  });

  await runtime.close();
  assert.equal(runtime.server.listening, false);
  assert.equal(runtime.localServer.listening, false);
});

test("a local-listener startup failure rolls back the primary listener", async (t) => {
  const blocker = createNetServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(() => resolve())));

  const runtime = createInternetCafeServer({
    host: "127.0.0.1",
    port: 0,
    publicDir: new URL("../public", import.meta.url).pathname,
    phoneBaseUrl: "https://cafe.example/kiosk",
    maxPayloadBytes: 1024 * 1024,
    maxBufferedBytes: 1024 * 1024,
    helloTimeoutMs: 2_000,
    heartbeatIntervalMs: 60_000,
    localHttpEnabled: true,
    localHttpHost: "127.0.0.1",
    localHttpPort: blocker.address().port,
  }, { logger: QUIET_LOGGER });

  await assert.rejects(runtime.start(), { code: "EADDRINUSE" });
  assert.equal(runtime.server.listening, false);
  assert.equal(runtime.localServer.listening, false);
  await runtime.close();
});
