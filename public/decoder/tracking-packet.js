export const TRACKING_PACKET_MAGIC = 0x4b525449; // ASCII "ITRK" little-endian.
export const TRACKING_PACKET_VERSION = 1;
export const TRACKING_PACKET_HEADER_BYTES = 24;
export const TRACKING_VALUES_PER_LANDMARK = 3;
export const TRACKING_FACE_PRESENT_FLAG = 1;

export function encodeTrackingPacket(frameId, timestampMs, landmarks) {
  const landmarkCount = landmarks?.length || 0;
  const packet = new ArrayBuffer(
    TRACKING_PACKET_HEADER_BYTES
      + landmarkCount * TRACKING_VALUES_PER_LANDMARK * Float32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(packet);
  view.setUint32(0, TRACKING_PACKET_MAGIC, true);
  view.setUint16(4, TRACKING_PACKET_VERSION, true);
  view.setUint16(6, landmarkCount ? TRACKING_FACE_PRESENT_FLAG : 0, true);
  view.setUint32(8, frameId, true);
  view.setFloat64(12, timestampMs, true);
  view.setUint16(20, landmarkCount, true);
  view.setUint16(22, TRACKING_VALUES_PER_LANDMARK, true);

  let offset = TRACKING_PACKET_HEADER_BYTES;
  for (const landmark of landmarks || []) {
    view.setFloat32(offset, landmark.x, true);
    view.setFloat32(offset + 4, landmark.y, true);
    view.setFloat32(offset + 8, landmark.z, true);
    offset += TRACKING_VALUES_PER_LANDMARK * Float32Array.BYTES_PER_ELEMENT;
  }
  return packet;
}
