import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeTrackingPacket,
  TRACKING_FACE_PRESENT_FLAG,
  TRACKING_PACKET_HEADER_BYTES,
  TRACKING_PACKET_MAGIC,
  TRACKING_PACKET_VERSION,
  TRACKING_VALUES_PER_LANDMARK,
} from "../public/decoder/tracking-packet.js";

test("tracking packets contain a versioned header and little-endian Float32 landmarks", () => {
  const packet = encodeTrackingPacket(42, 1234.5, [
    { x: 0.25, y: 0.75, z: -0.125 },
    { x: 1, y: 0, z: 0.5 },
  ]);
  const view = new DataView(packet);

  assert.equal(view.getUint32(0, true), TRACKING_PACKET_MAGIC);
  assert.equal(view.getUint16(4, true), TRACKING_PACKET_VERSION);
  assert.equal(view.getUint16(6, true), TRACKING_FACE_PRESENT_FLAG);
  assert.equal(view.getUint32(8, true), 42);
  assert.equal(view.getFloat64(12, true), 1234.5);
  assert.equal(view.getUint16(20, true), 2);
  assert.equal(view.getUint16(22, true), TRACKING_VALUES_PER_LANDMARK);
  assert.equal(packet.byteLength, TRACKING_PACKET_HEADER_BYTES + 2 * 3 * 4);
  assert.equal(view.getFloat32(24, true), 0.25);
  assert.equal(view.getFloat32(28, true), 0.75);
  assert.equal(view.getFloat32(32, true), -0.125);
});

test("a no-face tracking packet clears stale landmarks", () => {
  const packet = encodeTrackingPacket(9, 50, undefined);
  const view = new DataView(packet);

  assert.equal(packet.byteLength, TRACKING_PACKET_HEADER_BYTES);
  assert.equal(view.getUint16(6, true), 0);
  assert.equal(view.getUint16(20, true), 0);
});
