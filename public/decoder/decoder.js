const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;
const OUTPUT_ASPECT = OUTPUT_WIDTH / OUTPUT_HEIGHT;
const RETURN_FPS = 24;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;
const STREAM_PATH = "/stream";
const TRACKING_RECONNECT_BASE_MS = 250;
const TRACKING_RECONNECT_MAX_MS = 8_000;
const MAX_PENDING_ICE_CANDIDATES = 64;

const params = new URLSearchParams(window.location.search);
const useWebRtc = params.get("transport") === "webrtc";
const canvas = document.querySelector("#decoder-canvas");
const status = document.querySelector("#status");
const context = canvas.getContext("2d", { alpha: false });

if (!context) {
  throw new Error("The decoder needs a 2D canvas context.");
}

function decoderSeat() {
  const value = params.get("seat");
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

// WebRTC mode keeps the Web Render TOP-facing canvas unchanged. Incoming camera
// video is painted to it, while a separate canvas turns TouchDesigner JPEGs into
// a low-latency return MediaStream for the phone.
const remoteVideo = document.createElement("video");
remoteVideo.autoplay = true;
remoteVideo.muted = true;
remoteVideo.playsInline = true;
remoteVideo.setAttribute("aria-hidden", "true");
// Keep the element renderable so Chromium does not throttle its video decode.
remoteVideo.style.cssText = "position:fixed;inset:0;width:1px;height:1px;opacity:0;pointer-events:none";

const returnCanvas = document.createElement("canvas");
returnCanvas.width = OUTPUT_WIDTH;
returnCanvas.height = OUTPUT_HEIGHT;
const returnContext = returnCanvas.getContext("2d", { alpha: false });
if (useWebRtc && !returnContext) {
  throw new Error("The WebRTC bridge needs a 2D return canvas context.");
}

if (useWebRtc) {
  document.body.append(remoteVideo);
  // Canvas capture starts with a deterministic frame even before TD sends output.
  returnContext.fillStyle = "black";
  returnContext.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
}

let peerConnection;
let peerSessionId;
let peerGeneration = 0;
let returnStream;
let videoPumpHandle;
let videoPumpUsesVideoCallback = false;
let lastFallbackVideoTime = -1;
let statsTimer;
let statsCollecting = false;
let latestReturnFrame = null;
let returnPaintScheduled = false;
let returnDecodeInFlight = false;
const pendingIceBySession = new Map();

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

function submitTrackingFrame() {
  if (!trackingWorkerReady || trackingFrameInFlight || isStopping) return;

  trackingFrameInFlight = true;
  frameId = (frameId + 1) >>> 0;
  const nextFrameId = frameId;
  const timestampMs = performance.now();
  createImageBitmap(canvas).then((bitmap) => {
    if (isStopping) {
      bitmap.close();
      trackingFrameInFlight = false;
      return;
    }
    trackingWorker.postMessage({
      type: "frame",
      bitmap,
      frameId: nextFrameId,
      timestampMs,
    }, [bitmap]);
  }).catch((error) => {
    trackingFrameInFlight = false;
    console.warn("Could not copy a decoder frame for tracking", error);
  });
}

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
    context.drawImage(bitmap, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    // Preserve the legacy zero-copy tracking path: the decoded JPEG bitmap can
    // be transferred directly without copying the decoder canvas again.
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

async function paintLatestReturnFrame() {
  returnPaintScheduled = false;
  if (returnDecodeInFlight) return;

  const frame = latestReturnFrame;
  latestReturnFrame = null;
  if (!frame) return;

  returnDecodeInFlight = true;
  try {
    const bitmap = await createImageBitmap(frame, { imageOrientation: "none" });
    returnContext.drawImage(bitmap, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    bitmap.close();
  } catch (error) {
    console.warn("Ignoring undecodable TouchDesigner return frame", error);
  } finally {
    returnDecodeInFlight = false;
  }

  if (latestReturnFrame) scheduleReturnPaint();
}

function scheduleReturnPaint() {
  if (returnPaintScheduled || returnDecodeInFlight) return;
  returnPaintScheduled = true;
  window.requestAnimationFrame(paintLatestReturnFrame);
}

function sendSignal(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function stopVideoPump() {
  if (videoPumpHandle === undefined) return;
  if (videoPumpUsesVideoCallback && remoteVideo.cancelVideoFrameCallback) {
    remoteVideo.cancelVideoFrameCallback(videoPumpHandle);
  } else {
    window.cancelAnimationFrame(videoPumpHandle);
  }
  videoPumpHandle = undefined;
}

function drawRemoteVideoFrame() {
  const sourceWidth = remoteVideo.videoWidth;
  const sourceHeight = remoteVideo.videoHeight;
  if (!sourceWidth || !sourceHeight || remoteVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  const sourceAspect = sourceWidth / sourceHeight;
  let sourceX = 0;
  let sourceY = 0;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceAspect > OUTPUT_ASPECT) {
    cropWidth = sourceHeight * OUTPUT_ASPECT;
    sourceX = (sourceWidth - cropWidth) / 2;
  } else if (sourceAspect < OUTPUT_ASPECT) {
    cropHeight = sourceWidth / OUTPUT_ASPECT;
    sourceY = (sourceHeight - cropHeight) / 2;
  }

  context.drawImage(
    remoteVideo,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    OUTPUT_WIDTH,
    OUTPUT_HEIGHT,
  );
  submitTrackingFrame();
  firstFramePainted = true;
  setStatus("WebRTC streaming", true);
}

function startVideoPump(generation) {
  stopVideoPump();
  lastFallbackVideoTime = -1;

  if (remoteVideo.requestVideoFrameCallback) {
    videoPumpUsesVideoCallback = true;
    const onVideoFrame = () => {
      if (generation !== peerGeneration || !peerConnection) return;
      drawRemoteVideoFrame();
      videoPumpHandle = remoteVideo.requestVideoFrameCallback(onVideoFrame);
    };
    videoPumpHandle = remoteVideo.requestVideoFrameCallback(onVideoFrame);
    return;
  }

  videoPumpUsesVideoCallback = false;
  const onAnimationFrame = () => {
    if (generation !== peerGeneration || !peerConnection) return;
    // RAF can run faster than the camera. Avoid copying the same decoded frame.
    if (remoteVideo.currentTime !== lastFallbackVideoTime) {
      lastFallbackVideoTime = remoteVideo.currentTime;
      drawRemoteVideoFrame();
    }
    videoPumpHandle = window.requestAnimationFrame(onAnimationFrame);
  };
  videoPumpHandle = window.requestAnimationFrame(onAnimationFrame);
}

function resetPeer() {
  peerGeneration += 1;
  stopVideoPump();
  if (statsTimer) window.clearInterval(statsTimer);
  statsTimer = undefined;
  statsCollecting = false;

  const oldPeer = peerConnection;
  peerConnection = undefined;
  peerSessionId = undefined;
  if (oldPeer) {
    oldPeer.onicecandidate = null;
    oldPeer.ontrack = null;
    oldPeer.onconnectionstatechange = null;
    oldPeer.close();
  }
  if (returnStream) {
    for (const track of returnStream.getTracks()) track.stop();
    returnStream = undefined;
  }
  remoteVideo.srcObject = null;
}

function queueRemoteIce(sessionId, candidate) {
  let queue = pendingIceBySession.get(sessionId);
  if (!queue) {
    queue = [];
    pendingIceBySession.set(sessionId, queue);
  }
  if (queue.length < MAX_PENDING_ICE_CANDIDATES) queue.push(candidate);
}

async function addRemoteIce(sessionId, candidate) {
  if (!sessionId || !(candidate === null || typeof candidate === "object")) return;
  if (!peerConnection) {
    queueRemoteIce(sessionId, candidate);
    return;
  }
  // Candidates for an earlier connection can arrive after a replacement offer.
  if (peerSessionId !== sessionId) return;
  if (!peerConnection.remoteDescription) {
    queueRemoteIce(sessionId, candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(candidate);
  } catch (error) {
    console.warn("Ignoring invalid WebRTC ICE candidate", error);
  }
}

function boundedVideoStats(report) {
  const codecById = new Map();
  for (const stat of report.values()) {
    if (stat.type === "codec") codecById.set(stat.id, stat.mimeType);
  }

  let inbound = null;
  let outbound = null;
  let network = null;
  for (const stat of report.values()) {
    if (stat.type === "inbound-rtp" && stat.kind === "video" && !stat.isRemote) {
      inbound = {
        codec: codecById.get(stat.codecId) ?? null,
        bytes: stat.bytesReceived ?? 0,
        frames: stat.framesDecoded ?? 0,
        dropped: stat.framesDropped ?? 0,
        fps: stat.framesPerSecond ?? null,
        packetsLost: stat.packetsLost ?? 0,
        jitter: stat.jitter ?? null,
      };
    } else if (stat.type === "outbound-rtp" && stat.kind === "video" && !stat.isRemote) {
      outbound = {
        codec: codecById.get(stat.codecId) ?? null,
        bytes: stat.bytesSent ?? 0,
        frames: stat.framesEncoded ?? stat.framesSent ?? 0,
        fps: stat.framesPerSecond ?? null,
        qualityLimitation: stat.qualityLimitationReason ?? null,
      };
    } else if (
      stat.type === "candidate-pair"
      && stat.state === "succeeded"
      && (stat.nominated || stat.selected)
    ) {
      network = {
        roundTripTime: stat.currentRoundTripTime ?? null,
        availableOutgoingBitrate: stat.availableOutgoingBitrate ?? null,
      };
    }
  }
  return { inbound, outbound, network };
}

function startStats(generation) {
  if (statsTimer) window.clearInterval(statsTimer);
  statsTimer = window.setInterval(async () => {
    const peer = peerConnection;
    const sessionId = peerSessionId;
    if (!peer || !sessionId || generation !== peerGeneration || statsCollecting) return;
    statsCollecting = true;
    try {
      const report = await peer.getStats();
      if (peer !== peerConnection || generation !== peerGeneration) return;
      const stats = boundedVideoStats(report);
      const diagnostics = {};
      if (stats.inbound) diagnostics.inbound = stats.inbound;
      if (stats.outbound) diagnostics.outbound = stats.outbound;
      sendSignal({
        type: "webrtc-stats",
        sessionId,
        timestamp: Date.now(),
        connectionState: peer.connectionState,
        ...diagnostics,
      });
    } catch (error) {
      console.warn("Could not read WebRTC statistics", error);
    } finally {
      statsCollecting = false;
    }
  }, 1_000);
}

async function acceptOffer(payload) {
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  const sdp = typeof payload.sdp === "string" ? payload.sdp : "";
  if (!sessionId || !sdp) return;

  resetPeer();
  peerSessionId = sessionId;
  firstFramePainted = false;
  const generation = peerGeneration;
  const peer = new RTCPeerConnection({ iceServers: [] });
  peerConnection = peer;

  peer.onicecandidate = (event) => {
    if (!event.candidate || peer !== peerConnection || generation !== peerGeneration) return;
    sendSignal({
      type: "webrtc-ice",
      sessionId,
      candidate: event.candidate.toJSON?.() ?? event.candidate,
    });
  };
  peer.ontrack = (event) => {
    if (peer !== peerConnection || generation !== peerGeneration || event.track.kind !== "video") return;
    remoteVideo.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    remoteVideo.play().catch((error) => {
      console.warn("Incoming WebRTC video could not autoplay", error);
      setStatus("WebRTC camera playback is blocked");
    });
    startVideoPump(generation);
  };
  peer.onconnectionstatechange = () => {
    if (peer !== peerConnection || generation !== peerGeneration) return;
    if (peer.connectionState === "connected") {
      if (!firstFramePainted) setStatus("WebRTC connected — waiting for camera frames…");
    } else if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
      setStatus(`WebRTC ${peer.connectionState}`);
    }
  };

  try {
    returnStream = returnCanvas.captureStream(RETURN_FPS);
    const returnTrack = returnStream.getVideoTracks()[0];
    if (!returnTrack) throw new Error("Return canvas did not provide a video track.");
    peer.addTrack(returnTrack, returnStream);

    await peer.setRemoteDescription({ type: "offer", sdp });
    const queuedIce = pendingIceBySession.get(sessionId) ?? [];
    pendingIceBySession.clear();
    for (const candidate of queuedIce) await peer.addIceCandidate(candidate);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (peer !== peerConnection || generation !== peerGeneration) return;
    sendSignal({ type: "webrtc-answer", sessionId, sdp: peer.localDescription.sdp });
    startStats(generation);
    setStatus("WebRTC negotiated — connecting…");
  } catch (error) {
    if (peer === peerConnection && generation === peerGeneration) {
      console.error("Could not accept WebRTC offer", error);
      setStatus("WebRTC negotiation failed");
      resetPeer();
    }
  }
}

function receiveControlMessage(rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch {
    return;
  }

  switch (payload?.type) {
    case "hello-ack":
      if (useWebRtc && payload.role === "webrtc-bridge") {
        setStatus(`WebRTC bridge ready (seat ${seat}) — waiting for phone…`);
      }
      break;
    case "webrtc-offer":
      if (useWebRtc) acceptOffer(payload);
      break;
    case "webrtc-ice":
      if (useWebRtc) addRemoteIce(payload.sessionId, payload.candidate);
      break;
    case "webrtc-peer-ready":
    case "peer-ready":
      if (useWebRtc && !peerConnection) setStatus("Phone ready — waiting for WebRTC offer…");
      break;
    default:
      break;
  }
}

function receiveMessage(event) {
  if (typeof event.data === "string") {
    receiveControlMessage(event.data);
    return;
  }

  // In bridge mode binary data is the TouchDesigner JPEG return. Legacy mode
  // keeps its original phone JPEG -> decoder canvas behavior.
  const frame = event.data instanceof Blob
    ? event.data
    : new Blob([event.data], { type: "image/jpeg" });
  if (useWebRtc) {
    latestReturnFrame = frame;
    scheduleReturnPaint();
  } else {
    latestFrame = frame;
    schedulePaint();
  }
}

function connect() {
  if (isStopping) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus(useWebRtc ? `Connecting WebRTC bridge (seat ${seat})…` : `Connecting (seat ${seat})…`);
  const connection = new WebSocket(websocketUrl());
  socket = connection;
  connection.binaryType = "blob";

  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    reconnectAttempt = 0;
    connection.send(JSON.stringify({
      type: "hello",
      role: useWebRtc ? "webrtc-bridge" : "decoder",
      seat,
    }));
    setStatus(useWebRtc ? "Registering WebRTC bridge…" : "Waiting for JPEG frames…");
  });

  connection.addEventListener("message", (event) => {
    if (socket === connection) receiveMessage(event);
  });
  connection.addEventListener("error", () => {
    // close owns reconnection so an error/close pair schedules only once.
    connection.close();
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) return;
    socket = undefined;
    if (useWebRtc) resetPeer();
    scheduleReconnect();
  });
}

window.addEventListener("beforeunload", () => {
  isStopping = true;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  if (trackingReconnectTimer) window.clearTimeout(trackingReconnectTimer);
  if (useWebRtc) resetPeer();
  if (socket) socket.close();
  if (trackingSocket) trackingSocket.close();
  trackingWorker.terminate();
});

connect();
connectTracking();
