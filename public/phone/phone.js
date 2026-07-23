const TARGET_SIZE = 512;
const TARGET_FPS = 10;
const JPEG_QUALITY = 0.7;
const MAX_BUFFERED_BYTES = 1_000_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

const params = new URLSearchParams(window.location.search);
const requestedSeat = params.get("seat");
const seat = requestedSeat && /^[1-9]\d*$/.test(requestedSeat) ? Number(requestedSeat) : 1;

const output = document.querySelector("#output");
const outputContext = output.getContext("2d", { alpha: false });
const video = document.querySelector("#camera");
const startPanel = document.querySelector("#start-panel");
const startButton = document.querySelector("#start-camera");
const cameraMessage = document.querySelector("#camera-message");
const statusElement = document.querySelector("#connection-status");
const uplinkElement = document.querySelector("#uplink-fps");
const downlinkElement = document.querySelector("#downlink-fps");
document.querySelector("#seat").textContent = `Seat ${seat}`;

const captureCanvas = document.createElement("canvas");
captureCanvas.width = TARGET_SIZE;
captureCanvas.height = TARGET_SIZE;
const captureContext = captureCanvas.getContext("2d", { alpha: false });

let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let stream;
let captureTimer;
let encoding = false;
let newestFrame;
let decoding = false;
let framesUp = 0;
let framesDown = 0;

function setStatus(message, kind = "waiting") {
  statusElement.textContent = message;
  statusElement.className = `status status--${kind}`;
}

function websocketUrl() {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/stream`;
}

function connect() {
  window.clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  setStatus(reconnectAttempt ? "Reconnecting…" : "Connecting…");
  const nextSocket = new WebSocket(websocketUrl());
  nextSocket.binaryType = "blob";
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    reconnectAttempt = 0;
    nextSocket.send(JSON.stringify({ type: "hello", role: "phone", seat }));
    setStatus(stream ? "Live" : "Connected — start camera", "live");
  });

  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket || typeof event.data === "string") return;
    enqueueProcessedFrame(event.data instanceof Blob
      ? event.data
      : new Blob([event.data], { type: "image/jpeg" }));
  });

  nextSocket.addEventListener("error", () => {
    // The close handler owns retries; browsers do not expose useful WS error detail.
    nextSocket.close();
  });

  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = undefined;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  const exponentialDelay = Math.min(RECONNECT_MIN_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
  const jitter = exponentialDelay * (0.85 + Math.random() * 0.3);
  setStatus(`Disconnected — retrying in ${(jitter / 1000).toFixed(1)}s`, "error");
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, jitter);
}

function resizeOutput() {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(window.innerWidth * scale));
  const height = Math.max(1, Math.round(window.innerHeight * scale));
  if (output.width !== width || output.height !== height) {
    output.width = width;
    output.height = height;
  }
}

function drawCover(image) {
  resizeOutput();
  const imageAspect = image.width / image.height;
  const canvasAspect = output.width / output.height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.width;
  let sourceHeight = image.height;

  if (imageAspect > canvasAspect) {
    sourceWidth = image.height * canvasAspect;
    sourceX = (image.width - sourceWidth) / 2;
  } else {
    sourceHeight = image.width / canvasAspect;
    sourceY = (image.height - sourceHeight) / 2;
  }
  outputContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height);
}

function enqueueProcessedFrame(blob) {
  newestFrame = blob; // Keep only the most recent server result while decoding.
  if (!decoding) void paintNewestFrame();
}

async function paintNewestFrame() {
  decoding = true;
  while (newestFrame) {
    const frame = newestFrame;
    newestFrame = undefined;
    try {
      const bitmap = await createImageBitmap(frame);
      // Always present the completed decode. Skipping it when a newer frame
      // arrives can starve painting forever on slower mobile decoders.
      drawCover(bitmap);
      framesDown += 1;
      bitmap.close();
    } catch {
      // Ignore a malformed or interrupted image and await the next result.
    }
  }
  decoding = false;
}

function captureAndSend() {
  if (encoding || !video.videoWidth || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;

  encoding = true;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const side = Math.min(sourceWidth, sourceHeight);
  const sourceX = (sourceWidth - side) / 2;
  const sourceY = (sourceHeight - side) / 2;
  captureContext.drawImage(video, sourceX, sourceY, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);

  captureCanvas.toBlob((blob) => {
    encoding = false;
    if (!blob || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(blob);
    framesUp += 1;
  }, "image/jpeg", JPEG_QUALITY);
}

async function startCamera() {
  startButton.disabled = true;
  cameraMessage.textContent = "Opening camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "user" } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    window.clearInterval(captureTimer);
    captureTimer = window.setInterval(captureAndSend, 1000 / TARGET_FPS);
    captureAndSend();
    startPanel.hidden = true;
    setStatus(socket?.readyState === WebSocket.OPEN ? "Live" : "Camera ready — connecting…", "live");
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "NotAllowedError"
      ? "Camera permission was denied. Try again after allowing access."
      : "Could not open the front camera. Try again.";
    cameraMessage.textContent = reason;
    startButton.disabled = false;
  }
}

window.addEventListener("resize", resizeOutput);
window.setInterval(() => {
  uplinkElement.textContent = String(framesUp);
  downlinkElement.textContent = String(framesDown);
  framesUp = 0;
  framesDown = 0;
}, 1000);
window.addEventListener("beforeunload", () => {
  window.clearInterval(captureTimer);
  window.clearTimeout(reconnectTimer);
  stream?.getTracks().forEach((track) => track.stop());
  socket?.close();
});

resizeOutput();
startButton.addEventListener("click", startCamera);
connect();
