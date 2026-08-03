export const TRACKING_PACKET_MAGIC = 0x4b525449; // ASCII "ITRK" little-endian.
export const TRACKING_PACKET_VERSION = 2;
export const TRACKING_PACKET_HEADER_BYTES = 28;
export const TRACKING_VALUES_PER_LANDMARK = 3;
export const TRACKING_VALUES_PER_BLENDSHAPE = 1;
export const TRACKING_FACE_PRESENT_FLAG = 1;
export const TRACKING_BLENDSHAPES_PRESENT_FLAG = 2;

// MediaPipe Face Landmarker returns these 52 canonical categories. Keep this
// order synchronized with TouchDesigner's blendshape Script CHOP callback.
export const TRACKING_BLENDSHAPE_NAMES = Object.freeze([
  "_neutral",
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawOpen",
  "jawRight",
  "mouthClose",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthFunnel",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthPucker",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "noseSneerLeft",
  "noseSneerRight",
]);

const BLENDSHAPE_INDEX = new Map(
  TRACKING_BLENDSHAPE_NAMES.map((name, index) => [name, index]),
);

function canonicalBlendshapeScores(categories) {
  if (!categories?.length) return undefined;

  const scores = new Float32Array(TRACKING_BLENDSHAPE_NAMES.length);
  let matchedCategory = false;
  for (const category of categories) {
    const index = BLENDSHAPE_INDEX.get(category?.categoryName);
    if (index === undefined) continue;
    const score = Number(category.score);
    scores[index] = Number.isFinite(score) ? score : 0;
    matchedCategory = true;
  }
  return matchedCategory ? scores : undefined;
}

export function encodeTrackingPacket(frameId, timestampMs, landmarks, blendshapeCategories) {
  const landmarkCount = landmarks?.length || 0;
  const blendshapeScores = landmarkCount
    ? canonicalBlendshapeScores(blendshapeCategories)
    : undefined;
  const blendshapeCount = blendshapeScores?.length || 0;
  const packet = new ArrayBuffer(
    TRACKING_PACKET_HEADER_BYTES
      + landmarkCount * TRACKING_VALUES_PER_LANDMARK * Float32Array.BYTES_PER_ELEMENT
      + blendshapeCount * TRACKING_VALUES_PER_BLENDSHAPE * Float32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(packet);
  view.setUint32(0, TRACKING_PACKET_MAGIC, true);
  view.setUint16(4, TRACKING_PACKET_VERSION, true);
  view.setUint16(
    6,
    (landmarkCount ? TRACKING_FACE_PRESENT_FLAG : 0)
      | (blendshapeCount ? TRACKING_BLENDSHAPES_PRESENT_FLAG : 0),
    true,
  );
  view.setUint32(8, frameId, true);
  view.setFloat64(12, timestampMs, true);
  view.setUint16(20, landmarkCount, true);
  view.setUint16(22, TRACKING_VALUES_PER_LANDMARK, true);
  view.setUint16(24, blendshapeCount, true);
  view.setUint16(26, TRACKING_VALUES_PER_BLENDSHAPE, true);

  let offset = TRACKING_PACKET_HEADER_BYTES;
  for (const landmark of landmarks || []) {
    view.setFloat32(offset, landmark.x, true);
    view.setFloat32(offset + 4, landmark.y, true);
    view.setFloat32(offset + 8, landmark.z, true);
    offset += TRACKING_VALUES_PER_LANDMARK * Float32Array.BYTES_PER_ELEMENT;
  }
  for (const score of blendshapeScores || []) {
    view.setFloat32(offset, score, true);
    offset += TRACKING_VALUES_PER_BLENDSHAPE * Float32Array.BYTES_PER_ELEMENT;
  }
  return packet;
}
