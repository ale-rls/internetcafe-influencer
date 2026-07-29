const OUTPUT_SIZE = 512;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;
const STREAM_PATH = "/stream";
const TRACKING_RECONNECT_BASE_MS = 250;
const TRACKING_RECONNECT_MAX_MS = 8_000;

const canvas = document.querySelector("#decoder-canvas");
const status = document.querySelector("#status");
const context = canvas.getContext("2d", { alpha: false });

if (!context) {
  throw new Error("The decoder needs a 2D canvas context.");
}

function decoderSeat() {
  const value = new URLSearchParams(window.location.search).get("seat");
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : 1;
}

const seat = decoderSeat();
let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let latestFrame = null;
let paintScheduled = false;
let decodeInFlight = false;
let firstFramePainted = false;
let isStopping = false;
let frameId = 0;
let trackingWorkerReady = false;
let trackingFrameInFlight = false;
let trackingSocket;
let trackingReconnectTimer;
let trackingReconnectAttempt = 0;
let trackingRegistered = false;

const trackingWorker = new Worker("./tracking-worker.js", { type: "module" });

function setStatus(message, hidden = false) {
  status.textContent = message;
  status.classList.toggle("is-hidden", hidden);
}

function websocketUrl() {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${STREAM_PATH}`;
}

function trackingReconnectDelay() {
  const ceiling = Math.min(
    TRACKING_RECONNECT_MAX_MS,
    TRACKING_RECONNECT_BASE_MS * 2 ** trackingReconnectAttempt,
  );
  trackingReconnectAttempt += 1;
  return Math.round(ceiling * (0.8 + Math.random() * 0.4));
}

function scheduleTrackingReconnect() {
  if (isStopping || trackingReconnectTimer) return;
  trackingRegistered = false;
  trackingReconnectTimer = window.setTimeout(() => {
    trackingReconnectTimer = undefined;
    connectTracking();
  }, trackingReconnectDelay());
}

function connectTracking() {
  if (isStopping) return;
  if (trackingSocket
    && (trackingSocket.readyState === WebSocket.OPEN
      || trackingSocket.readyState === WebSocket.CONNECTING)) return;

  const connection = new WebSocket(websocketUrl());
  connection.binaryType = "arraybuffer";
  trackingSocket = connection;

  connection.addEventListener("open", () => {
    if (trackingSocket !== connection) return;
    trackingReconnectAttempt = 0;
    connection.send(JSON.stringify({ type: "hello", role: "tracking-source", seat }));
  });
  connection.addEventListener("message", (event) => {
    if (trackingSocket !== connection || typeof event.data !== "string") return;
    try {
      const payload = JSON.parse(event.data);
      trackingRegistered = payload?.type === "hello-ack"
        && payload.role === "tracking-source"
        && String(payload.seat) === String(seat);
    } catch {
      // Ignore malformed status text; only the hello acknowledgement changes state.
    }
  });
  connection.addEventListener("error", () => connection.close());
  connection.addEventListener("close", () => {
    if (trackingSocket === connection) trackingSocket = undefined;
    scheduleTrackingReconnect();
  });
}

function sendTrackingPacket(packet) {
  if (!trackingRegistered || trackingSocket?.readyState !== WebSocket.OPEN) return;
  if (trackingSocket.bufferedAmount > 0) return;
  trackingSocket.send(packet);
}

trackingWorker.addEventListener("message", (event) => {
  switch (event.data?.type) {
    case "ready":
      trackingWorkerReady = true;
      document.body.dataset.trackingDelegate = event.data.delegate;
      break;
    case "tracking":
      sendTrackingPacket(event.data.packet);
      break;
    case "frame-complete":
      trackingFrameInFlight = false;
      break;
    case "frame-error":
      console.warn("MediaPipe could not process a decoder frame", event.data.message);
      break;
    case "fatal-error":
      trackingWorkerReady = false;
      trackingFrameInFlight = false;
      document.body.dataset.trackingError = event.data.message;
      console.error("MediaPipe tracking is unavailable", event.data.message);
      break;
    default:
      break;
  }
});

function nextReconnectDelay() {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  // A little jitter avoids every decoder reconnecting at exactly the same time.
  return Math.round(ceiling * (0.8 + Math.random() * 0.4));
}

function scheduleReconnect() {
  if (isStopping || reconnectTimer) return;

  const delay = nextReconnectDelay();
  setStatus(`Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

async function paintLatestFrame() {
  paintScheduled = false;
  if (decodeInFlight) return;

  const frame = latestFrame;
  latestFrame = null;
  if (!frame) return;

  decodeInFlight = true;
  try {
    const bitmap = await createImageBitmap(frame, { imageOrientation: "none" });
    // Always present the completed decode. latestFrame still holds only one
    // newer image, so latency stays bounded without risking paint starvation.
    context.drawImage(bitmap, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    if (trackingWorkerReady && !trackingFrameInFlight) {
      trackingFrameInFlight = true;
      frameId = (frameId + 1) >>> 0;
      const timestampMs = performance.now();
      trackingWorker.postMessage({ type: "frame", bitmap, frameId, timestampMs }, [bitmap]);
    } else {
      bitmap.close();
    }
    firstFramePainted = true;
    setStatus("Streaming", true);
  } catch (error) {
    console.warn("Ignoring undecodable decoder frame", error);
    if (!firstFramePainted) setStatus("Waiting for JPEG frames…");
  } finally {
    decodeInFlight = false;
  }

  if (latestFrame) schedulePaint();
}

function schedulePaint() {
  if (paintScheduled || decodeInFlight) return;
  paintScheduled = true;
  // Do not queue per-frame paints: paintLatestFrame always takes the newest Blob.
  window.requestAnimationFrame(paintLatestFrame);
}

function receiveMessage(event) {
  if (typeof event.data === "string") {
    // Control/status messages are deliberately ignored; this page is receive-only.
    return;
  }

  // The protocol sends binary JPEG frames. Blob avoids an eager ArrayBuffer copy.
  latestFrame = event.data instanceof Blob
    ? event.data
    : new Blob([event.data], { type: "image/jpeg" });
  schedulePaint();
}

function connect() {
  if (isStopping) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus(`Connecting (seat ${seat})…`);
  const connection = new WebSocket(websocketUrl());
  socket = connection;
  connection.binaryType = "blob";

  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    reconnectAttempt = 0;
    connection.send(JSON.stringify({ type: "hello", role: "decoder", seat }));
    setStatus("Waiting for JPEG frames…");
  });

  connection.addEventListener("message", (event) => {
    if (socket === connection) receiveMessage(event);
  });
  connection.addEventListener("error", () => {
    // close owns reconnection so an error/close pair schedules only once.
    connection.close();
  });
  connection.addEventListener("close", () => {
    if (socket === connection) socket = undefined;
    scheduleReconnect();
  });
}

window.addEventListener("beforeunload", () => {
  isStopping = true;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  if (trackingReconnectTimer) window.clearTimeout(trackingReconnectTimer);
  if (socket) socket.close();
  if (trackingSocket) trackingSocket.close();
  trackingWorker.terminate();
});

connect();
connectTracking();
