const TARGET_WIDTH = 720;
const TARGET_HEIGHT = 1280;
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT;
const CAMERA_WIDTH = 1280;
const CAMERA_HEIGHT = 960;
const CAMERA_ASPECT = CAMERA_WIDTH / CAMERA_HEIGHT;
const TARGET_FPS = 24;
const JPEG_QUALITY = 0.7;
// Prefer dropping a capture over queueing stale frames when the uplink is busy.
const MAX_BUFFERED_BYTES = 0;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const NOTIFICATION_DURATION_MS = 5_000;
const NOTIFICATION_TRANSITION_MS = 320;
const MAX_ACTIVE_NOTIFICATIONS = 20;
const MAX_LIVE_COMMENTS = 6;
const LIVE_UI_TRANSITION_MS = 220;
const WEBRTC_MAX_BITRATE = 4_000_000;
const FRAME_WATCHDOG_STALL_MS = 5_000;
const SLIDER_SEND_INTERVAL_MS = 40;

const params = new URLSearchParams(window.location.search);
const requestedSeat = params.get("seat");
const seat = requestedSeat && /^[1-9]\d*$/.test(requestedSeat) ? Number(requestedSeat) : 1;
const transport = params.get("transport") === "webrtc" ? "webrtc" : "jpeg";
const isWebRtcTransport = transport === "webrtc";
document.body.classList.toggle("transport-webrtc", isWebRtcTransport);

const output = document.querySelector("#output");
const outputContext = output.getContext("2d", { alpha: false });
const video = document.querySelector("#camera");
const webRtcOutput = document.querySelector("#webrtc-output");
const startPanel = document.querySelector("#start-panel");
const startButton = document.querySelector("#start-camera");
const cameraMessage = document.querySelector("#camera-message");
const statusElement = document.querySelector("#connection-status");
const fpsOverlayElement = document.querySelector("#fps-overlay");
const uplinkElement = document.querySelector("#uplink-fps");
const downlinkElement = document.querySelector("#downlink-fps");
const notificationRegion = document.querySelector("#notification-region");
const notificationTemplate = document.querySelector("#notification-template");
const liveUi = document.querySelector("#live-ui");
const liveCommentFeed = document.querySelector("#live-comment-feed");
const liveCommentTemplate = document.querySelector("#live-comment-template");
const filterStateElement = document.querySelector("#filter-state");
const previousFilterButton = document.querySelector("#previous-filter");
const nextFilterButton = document.querySelector("#next-filter");
const phoneSlider = document.querySelector("#phone-slider");
const sliderControl = document.querySelector(".slider-control");
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
let peerConnection;
let peerReady = false;
let peerSessionId;
let offerInFlight = false;
let pendingRemoteCandidates = [];
let statsCollecting = false;
let previousWebRtcFrameStats;
let peerRestartTimer;
let frameWatchdogTimer;
let watchedDecodedFrames;
let wakeLock;
let wakeLockRequestInFlight = false;
let liveUiEnabled = true;
let clearLiveCommentsTimer;
let sliderSendTimer;
let pendingSliderValue;
let lastSliderSentAt = -Infinity;
const notificationTimers = new Map();

function setStatus(message, kind = "waiting") {
  statusElement.textContent = message;
  statusElement.className = `status status--${kind}`;
}

async function requestScreenWakeLock() {
  if (
    wakeLock
    || wakeLockRequestInFlight
    || document.visibilityState !== "visible"
    || !("wakeLock" in navigator)
  ) return;

  wakeLockRequestInFlight = true;
  try {
    const requestedLock = await navigator.wakeLock.request("screen");
    if (document.visibilityState !== "visible") {
      await requestedLock.release();
      return;
    }
    wakeLock = requestedLock;
    requestedLock.addEventListener("release", () => {
      if (wakeLock === requestedLock) wakeLock = undefined;
    });
  } catch {
    // Wake locks can be unavailable, denied, or released by the operating system.
  } finally {
    wakeLockRequestInFlight = false;
  }
}

function releaseScreenWakeLock() {
  const previousLock = wakeLock;
  wakeLock = undefined;
  if (previousLock) void previousLock.release().catch(() => {});
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
    if (isWebRtcTransport) {
      peerReady = false;
      closePeerConnection();
    }
    nextSocket.send(JSON.stringify({ type: "hello", role: "phone", seat }));
    sendCameraInfo();
    setStatus(
      stream && isWebRtcTransport ? "Waiting for media bridge…" : stream ? "Live" : "Connected — start camera",
      "live",
    );
  });

  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) return;
    if (typeof event.data === "string") {
      receiveControlMessage(event.data);
      return;
    }
    if (!isWebRtcTransport) {
      enqueueProcessedFrame(event.data instanceof Blob
        ? event.data
        : new Blob([event.data], { type: "image/jpeg" }));
    }
  });

  nextSocket.addEventListener("error", () => {
    // The close handler owns retries; browsers do not expose useful WS error detail.
    nextSocket.close();
  });

  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = undefined;
    if (isWebRtcTransport) {
      peerReady = false;
      closePeerConnection();
    }
    scheduleReconnect();
  });
}

function sendCameraInfo() {
  if (!stream || !video.videoWidth || !video.videoHeight) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
  socket.send(JSON.stringify({
    type: "camera-info",
    source: {
      width: video.videoWidth,
      height: video.videoHeight,
    },
    track: {
      width: settings.width ?? null,
      height: settings.height ?? null,
      aspectRatio: settings.aspectRatio ?? null,
      frameRate: settings.frameRate ?? null,
      resizeMode: settings.resizeMode ?? null,
      facingMode: settings.facingMode ?? null,
    },
    output: {
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      orientation: window.screen.orientation?.type ?? null,
    },
    userAgent: navigator.userAgent,
  }));
}

function receiveControlMessage(rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch {
    return;
  }
  switch (payload?.type) {
    case "webrtc-peer-ready":
      if (!isWebRtcTransport) break;
      peerReady = payload.ready !== false;
      if (!peerReady) {
        closePeerConnection();
        setStatus("Waiting for media bridge…");
        break;
      }
      // A peer-ready announcement also identifies a restarted decoder, so use
      // a fresh session instead of allowing candidates from an old connection.
      closePeerConnection();
      void startPeerConnection();
      break;
    case "webrtc-answer":
      if (isWebRtcTransport) void receiveWebRtcAnswer(payload);
      break;
    case "webrtc-ice":
      if (isWebRtcTransport) void receiveRemoteIceCandidate(payload);
      break;
    case "notification":
      if (!NOTIFICATION_APPS[payload.app]) return;
      if (typeof payload.sender !== "string" || typeof payload.message !== "string") return;
      showNotification({
        app: payload.app,
        sender: payload.sender.slice(0, 60),
        message: payload.message.slice(0, 280),
      });
      break;
    case "live-comment":
      receiveLiveComment(payload);
      break;
    case "live-ui-state":
      if (typeof payload.enabled === "boolean") setLiveUiEnabled(payload.enabled);
      break;
    case "fps-overlay-state":
      if (typeof payload.enabled === "boolean") setFpsOverlayEnabled(payload.enabled);
      break;
    case "phone-controls-state":
      if (typeof payload.enabled === "boolean") setPhoneControlsEnabled(payload.enabled);
      break;
    case "filter-state":
      receiveFilterState(payload);
      break;
    case "slider-state":
      receiveSliderState(payload);
      break;
    default:
      break;
  }
}

function makePeerSessionId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function canSignalWebRtc() {
  return isWebRtcTransport && socket?.readyState === WebSocket.OPEN;
}

function sendWebRtcMessage(message) {
  if (!canSignalWebRtc()) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function resetFrameWatchdog() {
  window.clearTimeout(frameWatchdogTimer);
  frameWatchdogTimer = undefined;
  watchedDecodedFrames = undefined;
}

function armFrameWatchdog(peer, sessionId, decodedFrames) {
  if (
    (peer.connectionState !== "connected" && peer.connectionState !== "disconnected")
    || decodedFrames == null
  ) {
    resetFrameWatchdog();
    return;
  }

  if (watchedDecodedFrames != null && decodedFrames <= watchedDecodedFrames) return;
  watchedDecodedFrames = decodedFrames;
  window.clearTimeout(frameWatchdogTimer);
  frameWatchdogTimer = window.setTimeout(() => {
    frameWatchdogTimer = undefined;
    if (
      peerConnection !== peer
      || peerSessionId !== sessionId
      || (peer.connectionState !== "connected" && peer.connectionState !== "disconnected")
    ) return;
    setStatus("Media stalled — retrying…", "error");
    schedulePeerRestart();
  }, FRAME_WATCHDOG_STALL_MS);
}

function closePeerConnection() {
  window.clearTimeout(peerRestartTimer);
  peerRestartTimer = undefined;
  resetFrameWatchdog();
  const previousPeer = peerConnection;
  peerConnection = undefined;
  peerSessionId = undefined;
  offerInFlight = false;
  pendingRemoteCandidates = [];
  previousWebRtcFrameStats = undefined;
  statsCollecting = false;
  if (previousPeer) {
    previousPeer.onicecandidate = null;
    previousPeer.ontrack = null;
    previousPeer.onconnectionstatechange = null;
    previousPeer.close();
  }
  webRtcOutput.srcObject = null;
  uplinkElement.textContent = "0";
  downlinkElement.textContent = "0";
}

function schedulePeerRestart() {
  if (peerRestartTimer || !peerReady || !stream || !canSignalWebRtc()) return;
  peerRestartTimer = window.setTimeout(() => {
    peerRestartTimer = undefined;
    closePeerConnection();
    void startPeerConnection();
  }, 750);
}

async function startPeerConnection() {
  if (!isWebRtcTransport || !peerReady || !stream || !canSignalWebRtc()) return;
  if (peerConnection || offerInFlight) return;

  const sessionId = makePeerSessionId();
  const peer = new RTCPeerConnection({ iceServers: [] });
  peerConnection = peer;
  peerSessionId = sessionId;
  offerInFlight = true;

  peer.onicecandidate = ({ candidate }) => {
    if (peerConnection !== peer || peerSessionId !== sessionId) return;
    sendWebRtcMessage({
      type: "webrtc-ice",
      sessionId,
      candidate: candidate?.toJSON?.() ?? null,
    });
  };

  peer.ontrack = (event) => {
    if (peerConnection !== peer || event.track.kind !== "video") return;
    const receiver = event.receiver
      ?? peer.getReceivers().find((candidate) => candidate.track === event.track)
      ?? peer.getReceivers().find((candidate) => candidate.track?.kind === "video");
    try {
      if (receiver && "jitterBufferTarget" in receiver) {
        receiver.jitterBufferTarget = 0;
      } else if (receiver && "playoutDelayHint" in receiver) {
        receiver.playoutDelayHint = 0;
      }
    } catch {
      // Receiver latency hints are optional and may be read-only in some browsers.
      try {
        if (receiver && "playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
      } catch {
        // Keep receiving with the browser's default playout buffering.
      }
    }
    const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
    webRtcOutput.srcObject = remoteStream;
    void webRtcOutput.play().catch(() => {});
  };

  peer.onconnectionstatechange = () => {
    if (peerConnection !== peer) return;
    if (peer.connectionState === "connected") {
      offerInFlight = false;
      setStatus("Live", "live");
    } else if (peer.connectionState === "failed") {
      resetFrameWatchdog();
      setStatus("Media disconnected — retrying…", "error");
      schedulePeerRestart();
    } else if (peer.connectionState === "disconnected") {
      setStatus("Media interrupted…", "waiting");
      armFrameWatchdog(peer, sessionId, previousWebRtcFrameStats?.decoded ?? null);
    } else if (peer.connectionState === "closed") {
      resetFrameWatchdog();
    }
  };

  try {
    const cameraTrack = stream.getVideoTracks()[0];
    if (!cameraTrack) throw new Error("Camera video track is unavailable");
    try {
      cameraTrack.contentHint = "motion";
    } catch {
      // contentHint is best-effort and is not supported uniformly.
    }
    // addTrack creates a sendrecv transceiver, so the bridge can return its
    // processed canvas track on the same negotiated video section.
    const sender = peer.addTrack(cameraTrack, stream);

    try {
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxFramerate = TARGET_FPS;
      parameters.encodings[0].maxBitrate = WEBRTC_MAX_BITRATE;
      parameters.degradationPreference = "maintain-framerate";
      await sender.setParameters(parameters);
    } catch {
      // Encoding constraints are best-effort and are not supported uniformly.
    }

    const offer = await peer.createOffer();
    if (peerConnection !== peer || peerSessionId !== sessionId) return;
    await peer.setLocalDescription(offer);
    if (peerConnection !== peer || peerSessionId !== sessionId) return;
    if (!sendWebRtcMessage({ type: "webrtc-offer", sessionId, sdp: peer.localDescription.sdp })) {
      throw new Error("Signaling connection closed before the offer was sent");
    }
    setStatus("Connecting media…");
  } catch {
    if (peerConnection !== peer) return;
    offerInFlight = false;
    setStatus("Could not start media — retrying…", "error");
    schedulePeerRestart();
  }
}

async function receiveWebRtcAnswer(payload) {
  const peer = peerConnection;
  if (!peer || payload.sessionId !== peerSessionId || typeof payload.sdp !== "string") return;
  if (peer.signalingState !== "have-local-offer") return;
  try {
    await peer.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    if (peerConnection !== peer) return;
    offerInFlight = false;
    const candidates = pendingRemoteCandidates;
    pendingRemoteCandidates = [];
    for (const candidate of candidates) await peer.addIceCandidate(candidate);
  } catch {
    if (peerConnection === peer) schedulePeerRestart();
  }
}

async function receiveRemoteIceCandidate(payload) {
  const peer = peerConnection;
  if (!peer || payload.sessionId !== peerSessionId) return;
  const candidate = payload.candidate ?? null;
  if (!peer.remoteDescription) {
    // Bound the queue so malformed or duplicated signaling cannot grow memory.
    if (pendingRemoteCandidates.length < 64) pendingRemoteCandidates.push(candidate);
    return;
  }
  try {
    await peer.addIceCandidate(candidate);
  } catch {
    // A late or unsupported candidate is safe to ignore; other candidates may work.
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

async function collectAndSendWebRtcStats() {
  const peer = peerConnection;
  const sessionId = peerSessionId;
  if (!peer || !sessionId || statsCollecting) return;
  statsCollecting = true;
  try {
    const report = await peer.getStats();
    if (peerConnection !== peer || peerSessionId !== sessionId) return;

    const codecs = new Map();
    let outbound;
    let inbound;
    let remoteInbound;
    let candidatePair;
    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat.mimeType);
      if (stat.type === "outbound-rtp" && !stat.isRemote
          && (stat.kind === "video" || stat.mediaType === "video" || stat.framesEncoded != null)) outbound = stat;
      if (stat.type === "inbound-rtp" && !stat.isRemote
          && (stat.kind === "video" || stat.mediaType === "video" || stat.framesDecoded != null)) inbound = stat;
      if (stat.type === "remote-inbound-rtp"
          && (stat.kind === "video" || stat.mediaType === "video" || stat.roundTripTime != null)) remoteInbound = stat;
      if (stat.type === "candidate-pair" && stat.state === "succeeded"
          && (stat.selected || stat.nominated || !candidatePair)) candidatePair = stat;
    });

    const now = performance.now();
    const encoded = finiteOrNull(outbound?.framesEncoded);
    const decoded = finiteOrNull(inbound?.framesDecoded);
    let upFps = 0;
    let downFps = 0;
    if (previousWebRtcFrameStats?.sessionId === sessionId) {
      const elapsedSeconds = Math.max((now - previousWebRtcFrameStats.at) / 1000, 0.001);
      if (encoded != null && previousWebRtcFrameStats.encoded != null) {
        upFps = Math.max(0, Math.round((encoded - previousWebRtcFrameStats.encoded) / elapsedSeconds));
      }
      if (decoded != null && previousWebRtcFrameStats.decoded != null) {
        downFps = Math.max(0, Math.round((decoded - previousWebRtcFrameStats.decoded) / elapsedSeconds));
      }
    }
    previousWebRtcFrameStats = { sessionId, at: now, encoded, decoded };
    armFrameWatchdog(peer, sessionId, decoded);
    uplinkElement.textContent = String(upFps);
    downlinkElement.textContent = String(downFps);

    const payload = {
      type: "webrtc-stats",
      sessionId,
      timestamp: Date.now(),
      connectionState: peer.connectionState,
      outbound: {
        state: peer.iceConnectionState,
        codec: (codecs.get(outbound?.codecId) ?? null)?.slice?.(0, 40) ?? null,
        fps: upFps,
        frames: encoded,
        bytes: finiteOrNull(outbound?.bytesSent),
        packetLoss: finiteOrNull(remoteInbound?.packetsLost),
        rtt: finiteOrNull(remoteInbound?.roundTripTime ?? candidatePair?.currentRoundTripTime),
        qualityLimitation: typeof outbound?.qualityLimitationReason === "string"
          ? outbound.qualityLimitationReason.slice(0, 40)
          : null,
      },
      inbound: {
        state: peer.iceConnectionState,
        codec: (codecs.get(inbound?.codecId) ?? null)?.slice?.(0, 40) ?? null,
        fps: downFps,
        frames: decoded,
        bytes: finiteOrNull(inbound?.bytesReceived),
        packetLoss: finiteOrNull(inbound?.packetsLost),
        jitter: finiteOrNull(inbound?.jitter),
        jitterBufferDelay: finiteOrNull(inbound?.jitterBufferDelay),
        jitterBufferEmittedCount: finiteOrNull(inbound?.jitterBufferEmittedCount),
        totalDecodeTime: finiteOrNull(inbound?.totalDecodeTime),
        framesReceived: finiteOrNull(inbound?.framesReceived),
      },
    };
    sendWebRtcMessage(payload);
  } catch {
    // Statistics are diagnostic only and must never interrupt the stream.
  } finally {
    statsCollecting = false;
  }
}

function receiveLiveComment(payload) {
  if (!liveUiEnabled) return;
  if (typeof payload.id !== "string" || typeof payload.sender !== "string" || typeof payload.message !== "string") return;
  if (!Number.isFinite(payload.receivedAt)) return;
  if ([...liveCommentFeed.children].some(({ dataset }) => dataset.commentId === payload.id)) return;

  showLiveComment({
    id: payload.id.slice(0, 120),
    sender: payload.sender.trim().slice(0, 60),
    message: payload.message.trim().slice(0, 500),
  });
}

function showLiveComment(comment) {
  if (!comment.sender || !comment.message) return;

  while (liveCommentFeed.children.length >= MAX_LIVE_COMMENTS) {
    liveCommentFeed.firstElementChild.remove();
  }

  const element = liveCommentTemplate.content.firstElementChild.cloneNode(true);
  const avatar = element.querySelector("[data-comment-avatar]");
  element.dataset.commentId = comment.id;
  avatar.textContent = senderInitials(comment.sender);
  avatar.style.setProperty("--avatar-hue", String(avatarHue(comment.sender)));
  element.querySelector("[data-comment-sender]").textContent = comment.sender;
  element.querySelector("[data-comment-message]").textContent = comment.message;
  liveCommentFeed.append(element);
  window.requestAnimationFrame(() => element.classList.add("is-visible"));
}

function senderInitials(sender) {
  const parts = sender.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return sender.slice(0, 2).toUpperCase();
}

function avatarHue(sender) {
  let hash = 0;
  for (const character of sender) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 360;
}

function setLiveUiEnabled(enabled) {
  liveUiEnabled = enabled;
  liveUi.classList.toggle("is-disabled", !enabled);
  liveUi.setAttribute("aria-hidden", String(!enabled));
  window.clearTimeout(clearLiveCommentsTimer);

  if (enabled) {
    liveCommentFeed.replaceChildren();
    return;
  }

  for (const comment of liveCommentFeed.children) {
    comment.classList.remove("is-visible");
    comment.classList.add("is-leaving");
  }
  clearLiveCommentsTimer = window.setTimeout(() => liveCommentFeed.replaceChildren(), LIVE_UI_TRANSITION_MS);
}

function setFpsOverlayEnabled(enabled) {
  fpsOverlayElement.hidden = !enabled;
  document.body.classList.toggle("fps-overlay-hidden", !enabled);
}

function setPhoneControlsEnabled(enabled) {
  document.body.classList.toggle("phone-controls-hidden", !enabled);
  previousFilterButton.disabled = !enabled;
  nextFilterButton.disabled = !enabled;
  phoneSlider.disabled = !enabled;
}

function receiveFilterState(payload) {
  if (!Number.isInteger(payload.index) || payload.index < 0) return;
  if (!Number.isInteger(payload.count) || payload.count < 1 || payload.index >= payload.count) return;
  const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 80) : "";
  filterStateElement.textContent = name || `Filter ${payload.index + 1} of ${payload.count}`;
  filterStateElement.hidden = false;
}

function requestFilterStep(delta) {
  if (delta !== -1 && delta !== 1) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "filter-step", delta }));
}

function validSliderValue(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function setSliderValue(value) {
  const normalizedValue = validSliderValue(value);
  if (normalizedValue == null) return;
  const percentage = Math.round(normalizedValue * 100);
  phoneSlider.value = String(normalizedValue);
  phoneSlider.setAttribute("aria-valuetext", `${percentage}%`);
  sliderControl.style.setProperty("--slider-percent", `${normalizedValue * 100}%`);
}

function receiveSliderState(payload) {
  setSliderValue(payload.value);
}

function sendSliderValue(value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "slider-change", value }));
  lastSliderSentAt = performance.now();
}

function flushPendingSliderValue() {
  window.clearTimeout(sliderSendTimer);
  sliderSendTimer = undefined;
  if (pendingSliderValue == null) return;
  const value = pendingSliderValue;
  pendingSliderValue = undefined;
  sendSliderValue(value);
}

function queueSliderValue(value) {
  pendingSliderValue = value;
  const remainingDelay = SLIDER_SEND_INTERVAL_MS - (performance.now() - lastSliderSentAt);
  if (remainingDelay <= 0) {
    flushPendingSliderValue();
    return;
  }
  if (sliderSendTimer == null) {
    sliderSendTimer = window.setTimeout(flushPendingSliderValue, remainingDelay);
  }
}

function handleSliderInput() {
  const value = validSliderValue(phoneSlider.valueAsNumber);
  if (value == null) return;
  setSliderValue(value);
  queueSliderValue(value);
}

function handleSliderChange() {
  const value = validSliderValue(phoneSlider.valueAsNumber);
  if (value == null) return;
  window.clearTimeout(sliderSendTimer);
  sliderSendTimer = undefined;
  pendingSliderValue = undefined;
  setSliderValue(value);
  sendSliderValue(value);
}

function showNotification(notification) {
  while (notificationRegion.children.length >= MAX_ACTIVE_NOTIFICATIONS) {
    const oldest = notificationRegion.firstElementChild;
    const timers = notificationTimers.get(oldest);
    window.clearTimeout(timers?.expiryTimer);
    window.clearTimeout(timers?.transitionTimer);
    notificationTimers.delete(oldest);
    oldest.remove();
  }

  const card = notificationTemplate.content.firstElementChild.cloneNode(true);
  const notificationIcon = card.querySelector("[data-notification-icon]");
  const notificationApp = card.querySelector("[data-notification-app]");
  const notificationSender = card.querySelector("[data-notification-sender]");
  const notificationMessage = card.querySelector("[data-notification-message]");
  const presentation = NOTIFICATION_APPS[notification.app];
  notificationIcon.className = `notification-icon notification-icon--${notification.app}`;
  notificationIcon.textContent = presentation.glyph;
  notificationApp.textContent = presentation.label;
  notificationSender.textContent = notification.sender;
  notificationMessage.textContent = notification.message;
  card.addEventListener("click", () => dismissNotification(card));
  notificationRegion.append(card);
  window.requestAnimationFrame(() => card.classList.add("is-visible"));

  const timers = {
    expiryTimer: window.setTimeout(() => dismissNotification(card), NOTIFICATION_DURATION_MS),
    transitionTimer: undefined,
  };
  notificationTimers.set(card, timers);
}

function dismissNotification(card) {
  const timers = notificationTimers.get(card);
  if (!timers || card.classList.contains("is-leaving")) return;
  window.clearTimeout(timers.expiryTimer);
  card.classList.remove("is-visible");
  card.classList.add("is-leaving");

  timers.transitionTimer = window.setTimeout(() => {
    notificationTimers.delete(card);
    card.remove();
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

  // Start from the browser's wider, uncropped camera stream and perform the
  // only camera-to-output crop here so Android cannot pre-crop the sensor.
  if (Math.abs(sourceAspect - TARGET_ASPECT) > 0.01) {
    if (sourceAspect > TARGET_ASPECT) {
      sourceWidth = videoHeight * TARGET_ASPECT;
      sourceX = (videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = videoWidth / TARGET_ASPECT;
      sourceY = (videoHeight - sourceHeight) / 2;
    }
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
  void requestScreenWakeLock();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: CAMERA_WIDTH },
        height: { ideal: CAMERA_HEIGHT },
        aspectRatio: { ideal: CAMERA_ASPECT },
        resizeMode: { ideal: "none" },
        frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    sendCameraInfo();
    window.clearInterval(captureTimer);
    if (isWebRtcTransport) {
      captureTimer = undefined;
      void startPeerConnection();
    } else {
      captureTimer = window.setInterval(captureAndSend, 1000 / TARGET_FPS);
      captureAndSend();
    }
    startPanel.hidden = true;
    setStatus(
      socket?.readyState !== WebSocket.OPEN
        ? "Camera ready — connecting…"
        : isWebRtcTransport ? "Waiting for media bridge…" : "Live",
      "live",
    );
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "NotAllowedError"
      ? "Camera permission was denied. Try again after allowing access."
      : "Could not open the front camera. Try again.";
    cameraMessage.textContent = reason;
    startButton.disabled = false;
  }
}

window.addEventListener("resize", resizeOutput);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void requestScreenWakeLock();
  } else {
    releaseScreenWakeLock();
  }
});
window.setInterval(() => {
  if (isWebRtcTransport) {
    void collectAndSendWebRtcStats();
    return;
  }
  uplinkElement.textContent = String(framesUp);
  downlinkElement.textContent = String(framesDown);
  framesUp = 0;
  framesDown = 0;
}, 1000);
window.addEventListener("beforeunload", () => {
  window.clearInterval(captureTimer);
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(peerRestartTimer);
  window.clearTimeout(sliderSendTimer);
  resetFrameWatchdog();
  window.clearTimeout(clearLiveCommentsTimer);
  for (const timers of notificationTimers.values()) {
    window.clearTimeout(timers.expiryTimer);
    window.clearTimeout(timers.transitionTimer);
  }
  closePeerConnection();
  stream?.getTracks().forEach((track) => track.stop());
  socket?.close();
  releaseScreenWakeLock();
});

resizeOutput();
startButton.addEventListener("click", startCamera);
previousFilterButton.addEventListener("click", () => requestFilterStep(-1));
nextFilterButton.addEventListener("click", () => requestFilterStep(1));
phoneSlider.addEventListener("input", handleSliderInput);
phoneSlider.addEventListener("change", handleSliderChange);
void requestScreenWakeLock();
connect();
