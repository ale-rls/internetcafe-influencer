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
