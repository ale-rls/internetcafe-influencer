const SEAT_COUNT = 7;
const STALE_AFTER_MS = 5_000;

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function ageSeconds(timestamp, now) {
  return timestamp === null ? null : Math.max(0, (now - timestamp) / 1_000);
}

function frameCount(inbound) {
  return finiteNumber(inbound?.framesReceived) ?? finiteNumber(inbound?.frames);
}

function jitterBufferMilliseconds(inbound, previous, sessionId) {
  const delay = finiteNumber(inbound?.jitterBufferDelay);
  const emitted = finiteNumber(inbound?.jitterBufferEmittedCount);
  if (delay === null || emitted === null || emitted <= 0) return null;

  if (
    previous?.sessionId === sessionId
    && previous.jitterDelay !== null
    && previous.jitterEmitted !== null
    && emitted > previous.jitterEmitted
    && delay >= previous.jitterDelay
  ) {
    return ((delay - previous.jitterDelay) / (emitted - previous.jitterEmitted)) * 1_000;
  }
  return (delay / emitted) * 1_000;
}

export function updateSeatDiagnostics(health, previousBySeat = new Map(), now = Date.now()) {
  const nextBySeat = new Map();
  const rows = [];

  for (let seat = 1; seat <= SEAT_COUNT; seat += 1) {
    const seatKey = String(seat);
    const roles = health?.seats?.[seatKey] ?? {};
    const phoneStats = health?.webrtcStats?.[seatKey]?.phone;
    const bridgeStats = health?.webrtcStats?.[seatKey]?.["webrtc-bridge"];
    const inbound = phoneStats?.inbound;
    const previous = previousBySeat.get(seatKey);
    const sessionId = typeof phoneStats?.sessionId === "string" ? phoneStats.sessionId : null;
    const frames = frameCount(inbound);
    const sameSession = sessionId !== null && previous?.sessionId === sessionId;
    let lastFrameAt = sameSession ? previous.lastFrameAt : (phoneStats ? now : null);
    if (frames !== null && frames > (sameSession ? (previous.frames ?? -1) : -1)) lastFrameAt = now;

    const statsReceivedAt = finiteNumber(phoneStats?.receivedAt);
    const statsAgeSeconds = ageSeconds(statsReceivedAt, now);
    const frameAgeSeconds = ageSeconds(lastFrameAt, now);
    const bufferMs = jitterBufferMilliseconds(inbound, previous, sessionId);
    const returnFps = finiteNumber(inbound?.fps) ?? finiteNumber(bridgeStats?.outbound?.fps);
    const returnQualityLimitation = bridgeStats?.outbound?.qualityLimitation ?? null;
    const uplinkQualityLimitation = phoneStats?.outbound?.qualityLimitation ?? null;
    const returnIsLimited = returnQualityLimitation && returnQualityLimitation !== "none";
    const uplinkIsLimited = uplinkQualityLimitation && uplinkQualityLimitation !== "none";
    const qualityLimitation = returnIsLimited
      ? `return: ${returnQualityLimitation}`
      : (uplinkIsLimited ? `uplink: ${uplinkQualityLimitation}` : (phoneStats ? "none" : null));
    const phoneConnected = roles.phone === true;
    const decoderConnected = roles.decoder === true || roles["webrtc-bridge"] === true;
    const fullPath = decoderConnected && roles["touch-output"] === true;

    let state = "healthy";
    let stateLabel = "Live";
    if (!phoneConnected) {
      state = "offline";
      stateLabel = "Phone offline";
    } else if (!phoneStats || !inbound) {
      state = "starting";
      stateLabel = "Waiting for stats";
    } else if (statsAgeSeconds >= STALE_AFTER_MS / 1_000) {
      state = "stale";
      stateLabel = "Stats stale";
    } else if (frameAgeSeconds !== null && frameAgeSeconds >= STALE_AFTER_MS / 1_000) {
      state = "stalled";
      stateLabel = "Return stalled";
    } else if (!fullPath) {
      state = "warning";
      stateLabel = "Path incomplete";
    } else if (returnIsLimited) {
      state = "warning";
      stateLabel = `Return encoder ${returnQualityLimitation}`;
    } else if (uplinkIsLimited) {
      state = "warning";
      stateLabel = `Phone encoder ${uplinkQualityLimitation}`;
    }

    rows.push({
      seat,
      state,
      stateLabel,
      phoneConnected,
      decoderConnected,
      touchConnected: roles["touch-output"] === true,
      returnFps,
      bufferMs,
      statsAgeSeconds,
      frameAgeSeconds,
      qualityLimitation,
    });
    nextBySeat.set(seatKey, {
      sessionId,
      frames,
      lastFrameAt,
      jitterDelay: finiteNumber(inbound?.jitterBufferDelay),
      jitterEmitted: finiteNumber(inbound?.jitterBufferEmittedCount),
    });
  }

  return { rows, nextBySeat };
}
