import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  encodeTrackingPacket,
  TRACKING_BLENDSHAPES_PRESENT_FLAG,
  TRACKING_BLENDSHAPE_NAMES,
  TRACKING_FACE_PRESENT_FLAG,
  TRACKING_PACKET_HEADER_BYTES,
  TRACKING_PACKET_MAGIC,
  TRACKING_PACKET_VERSION,
  TRACKING_VALUES_PER_BLENDSHAPE,
  TRACKING_VALUES_PER_LANDMARK,
} from "../public/decoder/tracking-packet.js";

test("browser and TouchDesigner use the same canonical blendshape order", () => {
  const callbacks = readFileSync(
    new URL("../touchdesigner/scripts/tracking/blendshape_script_callbacks.py", import.meta.url),
    "utf8",
  );
  const namesBlock = callbacks.match(/BLENDSHAPE_NAMES = \(([\s\S]*?)\n\)/)?.[1];
  assert.ok(namesBlock, "TouchDesigner BLENDSHAPE_NAMES tuple is present");
  const touchDesignerNames = Array.from(namesBlock.matchAll(/'([^']+)'/g), (match) => match[1]);

  assert.deepEqual(touchDesignerNames, TRACKING_BLENDSHAPE_NAMES);
});

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
  assert.equal(view.getUint16(24, true), 0);
  assert.equal(view.getUint16(26, true), TRACKING_VALUES_PER_BLENDSHAPE);
  assert.equal(packet.byteLength, TRACKING_PACKET_HEADER_BYTES + 2 * 3 * 4);
  assert.equal(view.getFloat32(TRACKING_PACKET_HEADER_BYTES, true), 0.25);
  assert.equal(view.getFloat32(TRACKING_PACKET_HEADER_BYTES + 4, true), 0.75);
  assert.equal(view.getFloat32(TRACKING_PACKET_HEADER_BYTES + 8, true), -0.125);
});

test("tracking packets normalize MediaPipe blendshapes into the canonical channel order", () => {
  const packet = encodeTrackingPacket(
    7,
    250,
    [{ x: 0.1, y: 0.2, z: 0.3 }],
    [
      { categoryName: "jawOpen", score: 0.75 },
      { categoryName: "_neutral", score: 0.125 },
      { categoryName: "unknownFutureCategory", score: 1 },
    ],
  );
  const view = new DataView(packet);
  const blendshapeOffset = TRACKING_PACKET_HEADER_BYTES + 3 * Float32Array.BYTES_PER_ELEMENT;

  assert.equal(TRACKING_BLENDSHAPE_NAMES.length, 52);
  assert.equal(new Set(TRACKING_BLENDSHAPE_NAMES).size, 52);
  assert.equal(
    view.getUint16(6, true),
    TRACKING_FACE_PRESENT_FLAG | TRACKING_BLENDSHAPES_PRESENT_FLAG,
  );
  assert.equal(view.getUint16(24, true), TRACKING_BLENDSHAPE_NAMES.length);
  assert.equal(view.getUint16(26, true), TRACKING_VALUES_PER_BLENDSHAPE);
  assert.equal(
    packet.byteLength,
    blendshapeOffset + TRACKING_BLENDSHAPE_NAMES.length * Float32Array.BYTES_PER_ELEMENT,
  );
  assert.equal(view.getFloat32(blendshapeOffset, true), 0.125);
  assert.equal(
    view.getFloat32(
      blendshapeOffset
        + TRACKING_BLENDSHAPE_NAMES.indexOf("jawOpen") * Float32Array.BYTES_PER_ELEMENT,
      true,
    ),
    0.75,
  );
  assert.equal(
    view.getFloat32(
      blendshapeOffset
        + TRACKING_BLENDSHAPE_NAMES.indexOf("mouthSmileLeft") * Float32Array.BYTES_PER_ELEMENT,
      true,
    ),
    0,
  );
});

test("a no-face tracking packet clears stale landmarks and blendshapes", () => {
  const packet = encodeTrackingPacket(
    9,
    50,
    undefined,
    [{ categoryName: "jawOpen", score: 1 }],
  );
  const view = new DataView(packet);

  assert.equal(packet.byteLength, TRACKING_PACKET_HEADER_BYTES);
  assert.equal(view.getUint16(6, true), 0);
  assert.equal(view.getUint16(20, true), 0);
  assert.equal(view.getUint16(24, true), 0);
});
