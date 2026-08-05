import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadConfig } from "../server/config.js";
import { createInternetCafeServer } from "../server/index.js";

const QUIET_LOGGER = { info() {}, warn() {} };
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

async function startRuntime(t, overrides = {}) {
  const runtime = createInternetCafeServer({
    host: "127.0.0.1",
    port: 0,
    publicDir: PUBLIC_DIR,
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

function expectNoMessage(socket, durationMs = 225) {
  return new Promise((resolve, reject) => {
    const onMessage = () => {
      clearTimeout(timer);
      reject(new Error("received an unexpected WebSocket message"));
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve();
    }, durationMs);
    socket.once("message", onMessage);
  });
}

function waitForJsonMessages(socket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out waiting for ${count} WebSocket messages`));
    }, 2_000);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      messages.push(JSON.parse(data.toString()));
      if (messages.length < count) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.on("message", onMessage);
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

  const mediapipeModule = await fetch(`${baseUrl}/vendor/mediapipe/vision_bundle.mjs`);
  assert.equal(mediapipeModule.status, 200);
  assert.match(mediapipeModule.headers.get("content-type"), /^text\/javascript/);

  const mediapipeWasm = await fetch(`${baseUrl}/vendor/mediapipe/wasm/vision_wasm_internal.wasm`, {
    method: "HEAD",
  });
  assert.equal(mediapipeWasm.status, 200);
  assert.equal(mediapipeWasm.headers.get("content-type"), "application/wasm");

  const faceModel = await fetch(`${baseUrl}/models/face_landmarker.task`, { method: "HEAD" });
  assert.equal(faceModel.status, 200);
  assert.equal(faceModel.headers.get("content-type"), "application/octet-stream");

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
  assert.deepEqual(healthBody.commentRelay, {
    connected: false,
    connections: 0,
    stationIds: [],
    lastConnectedAt: null,
    lastCommentAt: null,
    rejectedConnections: 0,
  });
  assert.deepEqual(healthBody.comments, {
    received: 0,
    accepted: 0,
    rejected: 0,
    deliveredToPhones: 0,
    acceptedWithoutPhones: 0,
  });
  delete healthBody.uptimeSeconds;
  delete healthBody.commentRelay;
  delete healthBody.comments;
  assert.deepEqual(healthBody, {
    ok: true,
    status: "running",
    transport: "http/ws",
    localHttp: { enabled: false },
    phoneBaseUrl: "https://cafe.example/kiosk",
    websocketPaths: ["/", "/stream", "/comments/relay"],
    connections: 0,
    registeredConnections: 0,
    seats: {},
    cameras: {},
    controlStates: {},
    counters: {
      receivedFrames: 0,
      receivedBytes: 0,
      forwardedFrames: 0,
      forwardedBytes: 0,
      droppedNoDestination: 0,
      droppedBackpressure: 0,
      rejectedMessages: 0,
      replacedConnections: 0,
      forwardedControlMessages: 0,
      droppedControlNoDestination: 0,
      rateLimitedFilterSteps: 0,
      replayedLiveComments: 0,
    },
  });
});

test("comment relay authenticates version 1 comments and broadcasts compact phone messages", async (t) => {
  const { baseUrl } = await startRuntime(t, { relaySharedToken: "installation-secret" });
  const seatOnePhone = await connectRole(baseUrl, "phone", 1);
  const seatTwoPhone = await connectRole(baseUrl, "phone", 2);
  const relay = new WebSocket(`${baseUrl.replace("http", "ws")}/comments/relay`);
  await once(relay, "open");
  t.after(() => {
    seatOnePhone.close();
    seatTwoPhone.close();
    relay.close();
  });

  relay.send(JSON.stringify({
    protocol: "internetcafe.comments",
    version: 1,
    type: "hello",
    role: "comment-relay",
    stationId: "commenter-test",
    token: "installation-secret",
  }));

  const seatOneMessage = nextMessage(seatOnePhone);
  const seatTwoMessage = nextMessage(seatTwoPhone);
  relay.send(JSON.stringify({
    protocol: "internetcafe.comments",
    version: 1,
    type: "comment",
    stationId: "commenter-test",
    id: "comment-123",
    sender: "Guest10280",
    message: "that filter is wild",
    sentAt: 1_785_840_000_000,
    receivedAt: 1_785_840_000_123,
  }));

  const expected = {
    type: "live-comment",
    id: "comment-123",
    sender: "Guest10280",
    message: "that filter is wild",
    receivedAt: 1_785_840_000_123,
  };
  for (const received of await Promise.all([seatOneMessage, seatTwoMessage])) {
    assert.equal(received.isBinary, false);
    assert.deepEqual(JSON.parse(received.data.toString()), expected);
  }

  const health = await (await fetch(`${baseUrl}/healthz`)).json();
  assert.deepEqual(health.commentRelay.stationIds, ["commenter-test"]);
  assert.equal(health.commentRelay.connected, true);
  assert.equal(health.commentRelay.connections, 1);
  assert.ok(health.commentRelay.lastConnectedAt);
  assert.ok(health.commentRelay.lastCommentAt);
  assert.deepEqual(health.comments, {
    received: 1,
    accepted: 1,
    rejected: 0,
    deliveredToPhones: 2,
    acceptedWithoutPhones: 0,
  });
});

test("comment relay rejects a wrong token, wrong version, and malformed comments", async (t) => {
  const { baseUrl } = await startRuntime(t, { relaySharedToken: "installation-secret" });
  const relayUrl = `${baseUrl.replace("http", "ws")}/comments/relay`;

  const unauthorized = new WebSocket(relayUrl);
  await once(unauthorized, "open");
  unauthorized.send(JSON.stringify({
    protocol: "internetcafe.comments",
    version: 1,
    type: "hello",
    role: "comment-relay",
    stationId: "commenter-test",
    token: "wrong-secret",
  }));
  const [unauthorizedCode] = await once(unauthorized, "close");
  assert.equal(unauthorizedCode, 1008);

  const wrongVersion = new WebSocket(relayUrl);
  await once(wrongVersion, "open");
  wrongVersion.send(JSON.stringify({
    protocol: "internetcafe.comments",
    version: 2,
    type: "hello",
    role: "comment-relay",
    stationId: "commenter-test",
    token: "installation-secret",
  }));
  const [wrongVersionCode] = await once(wrongVersion, "close");
  assert.equal(wrongVersionCode, 1008);

  const malformed = new WebSocket(relayUrl);
  await once(malformed, "open");
  t.after(() => malformed.close());
  malformed.send(JSON.stringify({
    protocol: "internetcafe.comments",
    version: 1,
    type: "hello",
    role: "comment-relay",
    stationId: "commenter-test",
    token: "installation-secret",
  }));
  malformed.send(JSON.stringify({
    protocol: "internetcafe.comments",
    version: 1,
    type: "comment",
    stationId: "commenter-test",
    id: "missing-message",
    sender: "Guest10280",
    sentAt: 1_785_840_000_000,
    receivedAt: 1_785_840_000_123,
  }));
  const [malformedCode] = await once(malformed, "close");
  assert.equal(malformedCode, 1008);

  const health = await (await fetch(`${baseUrl}/healthz`)).json();
  assert.equal(health.comments.received, 1);
  assert.equal(health.comments.accepted, 0);
  assert.equal(health.comments.rejected, 1);
  assert.equal(health.commentRelay.rejectedConnections, 2);
});

test("TouchDesigner state is seat-specific and snapshots to a reconnecting phone", async (t) => {
  const { baseUrl } = await startRuntime(t);
  const touchOutput = await connectRole(baseUrl, "touch-output", 2);
  const trackingSink = await connectRole(baseUrl, "tracking-sink", 2);
  let phone = await connectRole(baseUrl, "phone", 2);
  t.after(() => {
    touchOutput.close();
    trackingSink.close();
    phone.close();
  });

  const liveUiMessage = nextMessage(phone);
  touchOutput.send(JSON.stringify({ type: "live-ui-state", enabled: false }));
  assert.deepEqual(JSON.parse((await liveUiMessage).data.toString()), {
    type: "live-ui-state",
    enabled: false,
  });

  const filterMessage = nextMessage(phone);
  trackingSink.send(JSON.stringify({
    type: "filter-state",
    index: 2,
    count: 5,
    name: "Liquid Face",
  }));
  assert.deepEqual(JSON.parse((await filterMessage).data.toString()), {
    type: "filter-state",
    index: 2,
    count: 5,
    name: "Liquid Face",
  });

  const phoneClosed = once(phone, "close");
  phone.close();
  await phoneClosed;

  phone = new WebSocket(`${baseUrl.replace("http", "ws")}/stream`);
  await once(phone, "open");
  const reconnectMessages = waitForJsonMessages(phone, 3);
  phone.send(JSON.stringify({ type: "hello", role: "phone", seat: 2 }));
  const messages = await reconnectMessages;
  assert.deepEqual(messages.find(({ type }) => type === "hello-ack"), {
    type: "hello-ack",
    role: "phone",
    seat: "2",
  });
  assert.deepEqual(messages.find(({ type }) => type === "live-ui-state"), {
    type: "live-ui-state",
    enabled: false,
  });
  assert.deepEqual(messages.find(({ type }) => type === "filter-state"), {
    type: "filter-state",
    index: 2,
    count: 5,
    name: "Liquid Face",
  });
});

test("phone filter steps reach only same-seat TouchDesigner and are rate-limited", async (t) => {
  const { baseUrl } = await startRuntime(t, { filterStepIntervalMs: 150 });
  const phone = await connectRole(baseUrl, "phone", 1);
  const sameSeatTracking = await connectRole(baseUrl, "tracking-sink", 1);
  const otherSeatTracking = await connectRole(baseUrl, "tracking-sink", 2);
  t.after(() => {
    phone.close();
    sameSeatTracking.close();
    otherSeatTracking.close();
  });

  const firstStep = nextMessage(sameSeatTracking);
  phone.send(JSON.stringify({ type: "filter-step", delta: 1 }));
  assert.deepEqual(JSON.parse((await firstStep).data.toString()), {
    type: "filter-step",
    delta: 1,
  });
  await expectNoMessage(otherSeatTracking, 50);

  phone.send(JSON.stringify({ type: "filter-step", delta: -1 }));
  await expectNoMessage(sameSeatTracking, 125);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const nextStep = nextMessage(sameSeatTracking);
  phone.send(JSON.stringify({ type: "filter-step", delta: -1 }));
  assert.deepEqual(JSON.parse((await nextStep).data.toString()), {
    type: "filter-step",
    delta: -1,
  });

  const phoneClosed = once(phone, "close");
  phone.send(JSON.stringify({ type: "filter-step", delta: 2 }));
  const [code] = await phoneClosed;
  assert.equal(code, 1008);
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
  assert.deepEqual(health.seats["1"], {
    phone: true,
    decoder: true,
    "touch-output": true,
    "tracking-source": false,
    "tracking-sink": false,
  });
  assert.equal(runtime.router.snapshot().counters.replacedConnections, 1);
});

test("seven phone seats can register concurrently and route seat 7 frames", async (t) => {
  const { baseUrl } = await startRuntime(t);
  const phones = await Promise.all(
    Array.from({ length: 7 }, (_, index) => connectRole(baseUrl, "phone", index + 1)),
  );
  const seatSevenDecoder = await connectRole(baseUrl, "decoder", 7);
  t.after(() => {
    for (const phone of phones) phone.close();
    seatSevenDecoder.close();
  });

  const seatSevenFrame = nextMessage(seatSevenDecoder);
  phones[6].send(Buffer.from("seat-seven-camera-jpeg"));
  assert.equal((await seatSevenFrame).data.toString(), "seat-seven-camera-jpeg");

  const health = await (await fetch(`${baseUrl}/healthz`)).json();
  assert.equal(Object.keys(health.seats).length, 7);
  for (let seat = 1; seat <= 7; seat += 1) {
    assert.equal(health.seats[String(seat)].phone, true);
  }
  assert.equal(health.seats["7"].decoder, true);
});

test("tracking-source packets reach only the matching tracking-sink", async (t) => {
  const { baseUrl } = await startRuntime(t);
  const source = await connectRole(baseUrl, "tracking-source", 1);
  const sink = await connectRole(baseUrl, "tracking-sink", 1);
  const otherSink = await connectRole(baseUrl, "tracking-sink", 2);
  t.after(() => {
    source.close();
    sink.close();
    otherSink.close();
  });

  const packet = Buffer.from("ITRK-binary-test");
  const received = nextMessage(sink);
  source.send(packet);
  const result = await received;
  assert.equal(result.isBinary, true);
  assert.deepEqual(result.data, packet);

  const health = await (await fetch(`${baseUrl}/healthz`)).json();
  assert.equal(health.seats["1"]["tracking-source"], true);
  assert.equal(health.seats["1"]["tracking-sink"], true);
  assert.equal(health.seats["2"]["tracking-sink"], true);
});

test("TLS configuration enables a loopback-only TouchDesigner listener by default", () => {
  const config = loadConfig({
    TLS_CERT_FILE: process.execPath,
    TLS_KEY_FILE: process.execPath,
    RELAY_SHARED_TOKEN: " installation-secret ",
    FILTER_STEP_INTERVAL_MS: "175",
    COMMENT_REPLAY_LIMIT: "5",
    COMMENT_REPLAY_MAX_AGE_MS: "90000",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8443);
  assert.equal(config.localHttpEnabled, true);
  assert.equal(config.localHttpHost, "127.0.0.1");
  assert.equal(config.localHttpPort, 8080);
  assert.equal(config.relaySharedToken, "installation-secret");
  assert.equal(config.filterStepIntervalMs, 175);
  assert.equal(config.commentReplayLimit, 5);
  assert.equal(config.commentReplayMaxAgeMs, 90_000);

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

  const primaryControl = await fetch(`${baseUrl}/control/`);
  assert.equal(primaryControl.status, 404);
  const localControl = await fetch(`${localBaseUrl}/control/`);
  assert.equal(localControl.status, 200);
  const localControlHtml = await localControl.text();
  assert.match(localControlHtml, /Notification control/);
  assert.match(localControlHtml, /data-seat="7"/);

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

  const notificationMessage = nextMessage(phone);
  const notificationResponse = await fetch(`${localBaseUrl}/api/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seat: "all",
      app: "instagram",
      sender: "internet.cafe",
      message: "Someone liked your photo.",
    }),
  });
  assert.equal(notificationResponse.status, 200);
  assert.deepEqual(await notificationResponse.json(), {
    ok: true,
    target: "all",
    deliveredSeats: ["1"],
    missingSeats: ["2", "3", "4", "5", "6", "7"],
  });
  const notificationFrame = await notificationMessage;
  assert.equal(notificationFrame.isBinary, false);
  assert.deepEqual(JSON.parse(notificationFrame.data.toString()), {
    type: "notification",
    app: "instagram",
    sender: "internet.cafe",
    message: "Someone liked your photo.",
    durationMs: 5_000,
    sentAt: JSON.parse(notificationFrame.data.toString()).sentAt,
  });

  const invalidNotification = await fetch(`${localBaseUrl}/api/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seat: 8, app: "instagram", sender: "x", message: "y" }),
  });
  assert.equal(invalidNotification.status, 400);

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
    publicDir: PUBLIC_DIR,
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
