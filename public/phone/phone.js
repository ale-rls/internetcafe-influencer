const TARGET_WIDTH = 720;
const TARGET_HEIGHT = 1280;
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT;
const TARGET_FPS = 23;
const JPEG_QUALITY = 0.7;
// Prefer dropping a capture over queueing stale frames when the uplink is busy.
const MAX_BUFFERED_BYTES = 0;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const NOTIFICATION_DURATION_MS = 5_000;
const NOTIFICATION_TRANSITION_MS = 320;
const MAX_QUEUED_NOTIFICATIONS = 8;

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
const notificationRegion = document.querySelector("#notification-region");
const phoneNotification = document.querySelector("#phone-notification");
const notificationIcon = document.querySelector("#notification-icon");
const notificationApp = document.querySelector("#notification-app");
const notificationSender = document.querySelector("#notification-sender");
const notificationMessage = document.querySelector("#notification-message");
document.querySelector("#seat").textContent = `Seat ${seat}`;

const NOTIFICATION_APPS = {
  instagram: { label: "Instagram", glyph: "◎" },
  whatsapp: { label: "WhatsApp", glyph: "⌕" },
};

const captureCanvas = document.createElement("canvas");
captureCanvas.width = TARGET_WIDTH;
captureCanvas.height = TARGET_HEIGHT;
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
let notificationTimer;
let notificationTransitionTimer;
let currentNotification;
const notificationQueue = [];

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
    if (socket !== nextSocket) return;
    if (typeof event.data === "string") {
      receiveControlMessage(event.data);
      return;
    }
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

function receiveControlMessage(rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch {
    return;
  }
  if (payload?.type !== "notification") return;
  if (!NOTIFICATION_APPS[payload.app]) return;
  if (typeof payload.sender !== "string" || typeof payload.message !== "string") return;

  notificationQueue.push({
    app: payload.app,
    sender: payload.sender.slice(0, 60),
    message: payload.message.slice(0, 280),
  });
  if (notificationQueue.length > MAX_QUEUED_NOTIFICATIONS) notificationQueue.shift();
  if (!currentNotification) showNextNotification();
}

function showNextNotification() {
  const notification = notificationQueue.shift();
  if (!notification) return;

  currentNotification = notification;
  const presentation = NOTIFICATION_APPS[notification.app];
  notificationIcon.className = `notification-icon notification-icon--${notification.app}`;
  notificationIcon.textContent = presentation.glyph;
  notificationApp.textContent = presentation.label;
  notificationSender.textContent = notification.sender;
  notificationMessage.textContent = notification.message;
  notificationRegion.hidden = false;
  phoneNotification.classList.remove("is-leaving");
  window.requestAnimationFrame(() => phoneNotification.classList.add("is-visible"));

  window.clearTimeout(notificationTimer);
  notificationTimer = window.setTimeout(dismissNotification, NOTIFICATION_DURATION_MS);
}

function dismissNotification() {
  if (!currentNotification) return;
  window.clearTimeout(notificationTimer);
  phoneNotification.classList.remove("is-visible");
  phoneNotification.classList.add("is-leaving");
  currentNotification = undefined;

  window.clearTimeout(notificationTransitionTimer);
  notificationTransitionTimer = window.setTimeout(() => {
    phoneNotification.classList.remove("is-leaving");
    notificationRegion.hidden = true;
    showNextNotification();
  }, NOTIFICATION_TRANSITION_MS);
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

  const targetSocket = socket;
  encoding = true;
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const sourceAspect = videoWidth / videoHeight;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = videoWidth;
  let sourceHeight = videoHeight;

  // Center-crop without stretching so the JPEG, decoder canvas, MediaPipe
  // landmarks, and TouchDesigner output all share one 9:16 coordinate space.
  if (sourceAspect > TARGET_ASPECT) {
    sourceWidth = videoHeight * TARGET_ASPECT;
    sourceX = (videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = videoWidth / TARGET_ASPECT;
    sourceY = (videoHeight - sourceHeight) / 2;
  }
  captureContext.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    TARGET_WIDTH,
    TARGET_HEIGHT,
  );

  captureCanvas.toBlob(async (blob) => {
    try {
      if (!blob || socket !== targetSocket || targetSocket.readyState !== WebSocket.OPEN) return;

      // Materialize the JPEG before send(). Browsers may prepare Blob payloads
      // asynchronously, which can make bufferedAmount lag behind queued frames.
      const jpeg = await blob.arrayBuffer();
      if (socket !== targetSocket || targetSocket.readyState !== WebSocket.OPEN) return;
      if (targetSocket.bufferedAmount > MAX_BUFFERED_BYTES) return;

      targetSocket.send(jpeg);
      framesUp += 1;
    } catch {
      // Drop an interrupted conversion/send and let the next capture retry.
    } finally {
      encoding = false;
    }
  }, "image/jpeg", JPEG_QUALITY);
}

async function startCamera() {
  startButton.disabled = true;
  cameraMessage.textContent = "Opening camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: TARGET_WIDTH },
        height: { ideal: TARGET_HEIGHT },
        aspectRatio: { ideal: TARGET_ASPECT },
        frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
      },
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
  window.clearTimeout(notificationTimer);
  window.clearTimeout(notificationTransitionTimer);
  stream?.getTracks().forEach((track) => track.stop());
  socket?.close();
});

resizeOutput();
phoneNotification.addEventListener("click", dismissNotification);
startButton.addEventListener("click", startCamera);
connect();
