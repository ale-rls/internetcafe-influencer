import {
  FaceLandmarker,
  FilesetResolver,
} from "/vendor/mediapipe/vision_bundle.mjs";
import { encodeTrackingPacket } from "./tracking-packet.js";

const WASM_ROOT = "/vendor/mediapipe/wasm";
const MODEL_PATH = "/models/face_landmarker.task";

let faceLandmarker;

async function createFaceLandmarker(delegate) {
  // Module workers cannot use importScripts(). The explicit module fileset
  // selects MediaPipe's ESM-compatible WASM loader.
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
      delegate,
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

async function initialize() {
  try {
    faceLandmarker = await createFaceLandmarker("GPU");
    self.postMessage({ type: "ready", delegate: "GPU" });
  } catch (gpuError) {
    console.warn("MediaPipe GPU initialization failed; falling back to CPU", gpuError);
    faceLandmarker = await createFaceLandmarker("CPU");
    self.postMessage({ type: "ready", delegate: "CPU" });
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "frame" || !faceLandmarker) return;

  const { bitmap, frameId, timestampMs } = event.data;
  try {
    const result = faceLandmarker.detectForVideo(bitmap, timestampMs);
    const packet = encodeTrackingPacket(
      frameId,
      timestampMs,
      result.faceLandmarks?.[0],
      result.faceBlendshapes?.[0]?.categories,
    );
    self.postMessage({ type: "tracking", packet }, [packet]);
  } catch (error) {
    const packet = encodeTrackingPacket(frameId, timestampMs, undefined);
    self.postMessage({ type: "tracking", packet }, [packet]);
    self.postMessage({
      type: "frame-error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap.close();
    self.postMessage({ type: "frame-complete" });
  }
});

initialize().catch((error) => {
  self.postMessage({
    type: "fatal-error",
    message: error instanceof Error ? error.message : String(error),
  });
});
