import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { FrameRouter } from "../server/frame-router.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = undefined;
  }

  send(data, options, callback) {
    this.sent.push({ data, options });
    callback?.();
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason || ""));
  }
}

function register(router, socket, role, seat = "1") {
  router.attach(socket);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "hello", role, seat })), false);
}

test("FrameRouter routes frames only within one seat and replaces an older role connection", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const decoder = new FakeSocket();
  const phone = new FakeSocket();
  const otherSeatDecoder = new FakeSocket();
  register(router, decoder, "decoder");
  register(router, phone, "phone");
  register(router, otherSeatDecoder, "decoder", "2");

  const frame = Buffer.from([0xff, 0xd8, 0xff]);
  phone.emit("message", frame, true);
  assert.deepEqual(decoder.sent.at(-1).data, frame);
  assert.equal(otherSeatDecoder.sent.length, 1, "other seat receives only its hello acknowledgement");

  const newerPhone = new FakeSocket();
  register(router, newerPhone, "phone");
  assert.deepEqual(phone.closed, { code: 4001, reason: "replaced by a newer connection" });
  assert.equal(router.snapshot().counters.replacedConnections, 1);
  assert.equal(router.snapshot().seats["1"].phone, true);
});

test("FrameRouter drops a frame instead of growing a backpressured destination queue", () => {
  const router = new FrameRouter({ maxBufferedBytes: 32, logger: { info() {}, warn() {} } });
  const decoder = new FakeSocket();
  const phone = new FakeSocket();
  register(router, decoder, "decoder");
  register(router, phone, "phone");

  decoder.bufferedAmount = 1;
  phone.emit("message", Buffer.alloc(12), true);

  const { counters } = router.snapshot();
  assert.equal(counters.receivedFrames, 1);
  assert.equal(counters.forwardedFrames, 0);
  assert.equal(counters.droppedBackpressure, 1);
  assert.equal(decoder.sent.length, 1, "no binary frame is queued after hello acknowledgement");
});

test("FrameRouter routes tracking packets only to the matching seat tracking sink", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const source = new FakeSocket();
  const sink = new FakeSocket();
  const otherSeatSink = new FakeSocket();
  register(router, source, "tracking-source", "1");
  register(router, sink, "tracking-sink", "1");
  register(router, otherSeatSink, "tracking-sink", "2");

  const packet = Buffer.from("ITRK-packet");
  source.emit("message", packet, true);

  assert.deepEqual(sink.sent.at(-1).data, packet);
  assert.equal(otherSeatSink.sent.length, 1, "other seat receives only its hello acknowledgement");
});

test("FrameRouter routes normalized slider changes only to the matching seat tracking sink", () => {
  const router = new FrameRouter({ sliderChangeIntervalMs: 0, logger: { info() {}, warn() {} } });
  const phone = new FakeSocket();
  const sink = new FakeSocket();
  const otherSeatSink = new FakeSocket();
  register(router, phone, "phone", "1");
  register(router, sink, "tracking-sink", "1");
  register(router, otherSeatSink, "tracking-sink", "2");

  phone.emit("message", Buffer.from(JSON.stringify({
    type: "slider-change",
    value: 0.42,
  })), false);

  assert.deepEqual(JSON.parse(sink.sent.at(-1).data), {
    type: "slider-change",
    value: 0.42,
  });
  assert.equal(otherSeatSink.sent.length, 1, "other seat receives only its hello acknowledgement");
});

test("FrameRouter coalesces rapid slider changes and preserves the latest value", async () => {
  const router = new FrameRouter({ sliderChangeIntervalMs: 20, logger: { info() {}, warn() {} } });
  const phone = new FakeSocket();
  const sink = new FakeSocket();
  register(router, phone, "phone", "1");
  register(router, sink, "tracking-sink", "1");

  for (const value of [0.1, 0.2, 0.3]) {
    phone.emit("message", Buffer.from(JSON.stringify({ type: "slider-change", value })), false);
  }
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(sink.sent.slice(1).map(({ data }) => JSON.parse(data)), [
    { type: "slider-change", value: 0.1 },
    { type: "slider-change", value: 0.3 },
  ]);
  assert.equal(router.snapshot().counters.rateLimitedSliderChanges, 2);
});

test("FrameRouter rejects slider values outside the normalized finite-number range", () => {
  for (const value of [-0.01, 1.01, "0.5", null]) {
    const router = new FrameRouter({ logger: { info() {}, warn() {} } });
    const phone = new FakeSocket();
    register(router, phone, "phone", "1");
    phone.emit("message", Buffer.from(JSON.stringify({ type: "slider-change", value })), false);
    assert.deepEqual(phone.closed, {
      code: 1008,
      reason: "slider-change value must be a finite number from 0 to 1",
    });
  }
});

test("FrameRouter forwards, caches, and replays the per-seat slider state", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const touchOutput = new FakeSocket();
  const phone = new FakeSocket();
  register(router, touchOutput, "touch-output", "3");
  register(router, phone, "phone", "3");

  touchOutput.emit("message", Buffer.from(JSON.stringify({
    type: "slider-state",
    value: 0.75,
  })), false);

  assert.deepEqual(JSON.parse(phone.sent.at(-1).data), {
    type: "slider-state",
    value: 0.75,
  });
  assert.deepEqual(router.snapshot().controlStates["3"].slider, {
    type: "slider-state",
    value: 0.75,
  });

  const replacementPhone = new FakeSocket();
  register(router, replacementPhone, "phone", "3");
  assert.deepEqual(replacementPhone.sent.map(({ data }) => JSON.parse(data)), [
    { type: "hello-ack", role: "phone", seat: "3" },
    { type: "slider-state", value: 0.75 },
  ]);
});

test("FrameRouter rejects binary messages from receive-only roles", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const sink = new FakeSocket();
  register(router, sink, "tracking-sink", "1");

  sink.emit("message", Buffer.from("not-allowed"), true);

  assert.deepEqual(sink.closed, { code: 1008, reason: "tracking-sink is receive-only" });
  assert.equal(router.snapshot().counters.rejectedMessages, 1);
});

test("FrameRouter exposes bounded phone camera diagnostics by seat", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const phone = new FakeSocket();
  register(router, phone, "phone", "2");

  phone.emit("message", Buffer.from(JSON.stringify({
    type: "camera-info",
    source: { width: 1920, height: 1080 },
    track: {
      width: 1920,
      height: 1080,
      aspectRatio: 16 / 9,
      frameRate: 30,
      resizeMode: "crop-and-scale",
      facingMode: "user",
    },
    output: { width: 720, height: 1280 },
    viewport: {
      width: 360,
      height: 780,
      devicePixelRatio: 3,
      orientation: "portrait-primary",
    },
    userAgent: "Android test browser",
  })), false);

  const diagnostics = router.snapshot().cameras["2"];
  assert.deepEqual(diagnostics.source, { width: 1920, height: 1080 });
  assert.deepEqual(diagnostics.track, {
    width: 1920,
    height: 1080,
    aspectRatio: 16 / 9,
    frameRate: 30,
    resizeMode: "crop-and-scale",
    facingMode: "user",
  });
  assert.deepEqual(diagnostics.output, { width: 720, height: 1280 });
  assert.equal(diagnostics.viewport.orientation, "portrait-primary");
  assert.equal(diagnostics.userAgent, "Android test browser");
  assert.ok(Number.isInteger(diagnostics.receivedAt));
});

test("FrameRouter sends notification text only to the requested phone seats", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const seatOnePhone = new FakeSocket();
  const seatTwoPhone = new FakeSocket();
  const seatTwoDecoder = new FakeSocket();
  register(router, seatOnePhone, "phone", "1");
  register(router, seatTwoPhone, "phone", "2");
  register(router, seatTwoDecoder, "decoder", "2");

  const delivery = router.sendNotification({
    app: "whatsapp",
    sender: "Internet Cafe",
    message: "Meet me at seat two.",
  }, ["2", "4"]);

  assert.deepEqual(delivery, { deliveredSeats: ["2"], missingSeats: ["4"] });
  assert.equal(seatOnePhone.sent.length, 1, "seat one receives only its hello acknowledgement");
  assert.equal(seatTwoDecoder.sent.length, 1, "decoder receives only its hello acknowledgement");
  assert.equal(seatTwoPhone.sent.at(-1).options.binary, false);
  assert.deepEqual(
    JSON.parse(seatTwoPhone.sent.at(-1).data),
    {
      type: "notification",
      app: "whatsapp",
      sender: "Internet Cafe",
      message: "Meet me at seat two.",
      durationMs: 5_000,
      sentAt: JSON.parse(seatTwoPhone.sent.at(-1).data).sentAt,
    },
  );
});

test("FrameRouter replays a bounded live-comment snapshot when a phone connects", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  router.broadcastLiveComment({
    id: "comment-before-phone",
    sender: "Guest10280",
    message: "show me after connect",
    receivedAt: 1_785_840_000_123,
  });

  const phone = new FakeSocket();
  register(router, phone, "phone", "1");

  assert.equal(phone.sent.length, 2);
  assert.deepEqual(JSON.parse(phone.sent.at(-1).data), {
    type: "live-comment",
    id: "comment-before-phone",
    sender: "Guest10280",
    message: "show me after connect",
    receivedAt: 1_785_840_000_123,
  });
  assert.equal(router.snapshot().counters.replayedLiveComments, 1);
});

test("FrameRouter does not replay comments received while Live UI is disabled", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const touchOutput = new FakeSocket();
  register(router, touchOutput, "touch-output", "1");
  touchOutput.emit("message", Buffer.from(JSON.stringify({
    type: "live-ui-state",
    enabled: false,
  })), false);

  router.broadcastLiveComment({
    id: "comment-while-hidden",
    sender: "Guest10280",
    message: "do not replay me",
    receivedAt: 1_785_840_000_123,
  });

  const phone = new FakeSocket();
  register(router, phone, "phone", "1");
  assert.deepEqual(phone.sent.map(({ data }) => JSON.parse(data)), [
    { type: "hello-ack", role: "phone", seat: "1" },
    { type: "live-ui-state", enabled: false },
  ]);
  assert.equal(router.snapshot().counters.replayedLiveComments, 0);
});

test("FrameRouter forwards and replays the per-seat FPS overlay state", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const touchOutput = new FakeSocket();
  const phone = new FakeSocket();
  register(router, touchOutput, "touch-output", "3");
  register(router, phone, "phone", "3");

  touchOutput.emit("message", Buffer.from(JSON.stringify({
    type: "fps-overlay-state",
    enabled: false,
  })), false);

  assert.deepEqual(JSON.parse(phone.sent.at(-1).data), {
    type: "fps-overlay-state",
    enabled: false,
  });
  assert.deepEqual(router.snapshot().controlStates["3"].fpsOverlay, {
    type: "fps-overlay-state",
    enabled: false,
  });

  const replacementPhone = new FakeSocket();
  register(router, replacementPhone, "phone", "3");
  assert.deepEqual(replacementPhone.sent.map(({ data }) => JSON.parse(data)), [
    { type: "hello-ack", role: "phone", seat: "3" },
    { type: "fps-overlay-state", enabled: false },
  ]);
});

test("FrameRouter relays WebRTC signaling only between matching-seat peers", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const phone = new FakeSocket();
  const bridge = new FakeSocket();
  const otherBridge = new FakeSocket();
  register(router, bridge, "webrtc-bridge", "1");
  register(router, otherBridge, "webrtc-bridge", "2");
  register(router, phone, "phone", "1");

  assert.deepEqual(JSON.parse(bridge.sent.at(-1).data), {
    type: "webrtc-peer-ready",
    role: "phone",
  });
  assert.deepEqual(JSON.parse(phone.sent.at(-1).data), {
    type: "webrtc-peer-ready",
    role: "webrtc-bridge",
  });
  const otherBridgeMessageCount = otherBridge.sent.length;

  phone.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-offer",
    sessionId: "seat-1:session-1",
    sdp: "v=0\r\n",
  })), false);
  assert.deepEqual(JSON.parse(bridge.sent.at(-1).data), {
    type: "webrtc-offer",
    sessionId: "seat-1:session-1",
    sdp: "v=0\r\n",
  });
  assert.equal(otherBridge.sent.length, otherBridgeMessageCount);

  bridge.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-answer",
    sessionId: "seat-1:session-1",
    sdp: "v=0\r\na=answer\r\n",
  })), false);
  assert.deepEqual(JSON.parse(phone.sent.at(-1).data), {
    type: "webrtc-answer",
    sessionId: "seat-1:session-1",
    sdp: "v=0\r\na=answer\r\n",
  });

  phone.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-ice",
    sessionId: "seat-1:session-1",
    candidate: {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "bounded",
      ignoredExtraProperty: "not relayed",
    },
  })), false);
  assert.deepEqual(JSON.parse(bridge.sent.at(-1).data), {
    type: "webrtc-ice",
    sessionId: "seat-1:session-1",
    candidate: {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "bounded",
    },
  });
});

test("FrameRouter prefers a same-seat WebRTC bridge for TouchDesigner frames and falls back", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const phone = new FakeSocket();
  const bridge = new FakeSocket();
  const touchOutput = new FakeSocket();
  register(router, phone, "phone", "1");
  register(router, touchOutput, "touch-output", "1");

  touchOutput.emit("message", Buffer.from("legacy-return"), true);
  assert.deepEqual(phone.sent.at(-1).data, Buffer.from("legacy-return"));

  register(router, bridge, "webrtc-bridge", "1");
  const phoneMessageCount = phone.sent.length;
  touchOutput.emit("message", Buffer.from("webrtc-return"), true);
  assert.deepEqual(bridge.sent.at(-1).data, Buffer.from("webrtc-return"));
  assert.equal(phone.sent.length, phoneMessageCount, "phone does not receive a duplicate return frame");

  bridge.close(1000, "test fallback");
  touchOutput.emit("message", Buffer.from("fallback-return"), true);
  assert.deepEqual(phone.sent.at(-1).data, Buffer.from("fallback-return"));
});

test("FrameRouter rejects malformed and role-disallowed WebRTC signaling", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });

  const bridgeOffer = new FakeSocket();
  register(router, bridgeOffer, "webrtc-bridge", "1");
  bridgeOffer.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-offer",
    sessionId: "session-1",
    sdp: "v=0\r\n",
  })), false);
  assert.deepEqual(bridgeOffer.closed, {
    code: 1008,
    reason: "webrtc-bridge cannot send webrtc-offer",
  });

  const invalidSession = new FakeSocket();
  register(router, invalidSession, "phone", "1");
  invalidSession.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-offer",
    sessionId: "spaces are not valid",
    sdp: "v=0\r\n",
  })), false);
  assert.equal(invalidSession.closed?.code, 1008);

  const invalidCandidate = new FakeSocket();
  register(router, invalidCandidate, "phone", "2");
  invalidCandidate.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-ice",
    sessionId: "session-2",
    candidate: { candidate: 42 },
  })), false);
  assert.deepEqual(invalidCandidate.closed, {
    code: 1008,
    reason: "webrtc-ice requires a valid candidate",
  });

  const decoder = new FakeSocket();
  register(router, decoder, "decoder", "3");
  decoder.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-answer",
    sessionId: "session-3",
    sdp: "v=0\r\n",
  })), false);
  assert.deepEqual(decoder.closed, {
    code: 1008,
    reason: "decoder cannot send this text message",
  });
  assert.equal(router.snapshot().counters.rejectedMessages, 4);
});

test("FrameRouter stores bounded WebRTC diagnostics without relaying them", () => {
  const router = new FrameRouter({ logger: { info() {}, warn() {} } });
  const phone = new FakeSocket();
  const bridge = new FakeSocket();
  register(router, phone, "phone", "4");
  register(router, bridge, "webrtc-bridge", "4");
  const bridgeMessageCount = bridge.sent.length;

  phone.emit("message", Buffer.from(JSON.stringify({
    type: "webrtc-stats",
    sessionId: "seat-4-session",
    timestamp: 1234.5,
    connectionState: "connected",
    inbound: { framesPerSecond: 10, framesDropped: 2, codec: "VP8" },
    outbound: { framesPerSecond: 23, bytesSent: 123456, qualityLimited: false },
  })), false);

  assert.equal(bridge.sent.length, bridgeMessageCount, "diagnostics are not relayed");
  const stats = router.snapshot().webrtcStats["4"].phone;
  assert.deepEqual(stats.inbound, { framesPerSecond: 10, framesDropped: 2, codec: "VP8" });
  assert.deepEqual(stats.outbound, {
    framesPerSecond: 23,
    bytesSent: 123456,
    qualityLimited: false,
  });
  assert.equal(stats.sessionId, "seat-4-session");
  assert.equal(stats.connectionState, "connected");
  assert.ok(Number.isInteger(stats.receivedAt));
});
