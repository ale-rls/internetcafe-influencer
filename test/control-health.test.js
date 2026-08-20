import test from "node:test";
import assert from "node:assert/strict";

import { updateSeatDiagnostics } from "../public/control/health-dashboard.js";

test("seat diagnostics tolerate missing connections and WebRTC statistics", () => {
  const { rows, nextBySeat } = updateSeatDiagnostics({}, new Map(), 10_000);

  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], {
    seat: 1,
    state: "offline",
    stateLabel: "Phone offline",
    phoneConnected: false,
    decoderConnected: false,
    touchConnected: false,
    returnFps: null,
    bufferMs: null,
    statsAgeSeconds: null,
    frameAgeSeconds: null,
    qualityLimitation: null,
  });
  assert.equal(nextBySeat.size, 7);
});

test("seat diagnostics use poll deltas for jitter-buffer and frame freshness", () => {
  const firstHealth = {
    seats: {
      "1": { phone: true, decoder: false, "touch-output": true, "webrtc-bridge": true },
    },
    webrtcStats: {
      "1": {
        phone: {
          sessionId: "session-1",
          receivedAt: 10_000,
          inbound: {
            fps: 20,
            framesReceived: 100,
            jitterBufferDelay: 1.5,
            jitterBufferEmittedCount: 100,
          },
        },
        "webrtc-bridge": { outbound: { fps: 22, qualityLimitation: "none" } },
      },
    },
  };
  const first = updateSeatDiagnostics(firstHealth, new Map(), 10_000);
  assert.equal(first.rows[0].state, "healthy");
  assert.equal(first.rows[0].returnFps, 20);
  assert.equal(first.rows[0].bufferMs, 15);
  assert.equal(first.rows[0].frameAgeSeconds, 0);

  const secondHealth = structuredClone(firstHealth);
  secondHealth.webrtcStats["1"].phone.receivedAt = 12_000;
  Object.assign(secondHealth.webrtcStats["1"].phone.inbound, {
    framesReceived: 120,
    jitterBufferDelay: 1.7,
    jitterBufferEmittedCount: 120,
  });
  const second = updateSeatDiagnostics(secondHealth, first.nextBySeat, 12_000);
  assert.ok(Math.abs(second.rows[0].bufferMs - 10) < 0.0001);
  assert.equal(second.rows[0].frameAgeSeconds, 0);

  secondHealth.webrtcStats["1"].phone.receivedAt = 18_000;
  const stalled = updateSeatDiagnostics(secondHealth, second.nextBySeat, 18_000);
  assert.equal(stalled.rows[0].state, "stalled");
  assert.equal(stalled.rows[0].stateLabel, "Return stalled");
  assert.equal(stalled.rows[0].frameAgeSeconds, 6);
});

test("seat diagnostics expose stale stats and encoder limitations", () => {
  const health = {
    seats: { "2": { phone: true, decoder: true, "touch-output": true } },
    webrtcStats: {
      "2": {
        phone: {
          sessionId: "session-2",
          receivedAt: 1_000,
          inbound: { frames: 5, fps: 18 },
        },
        "webrtc-bridge": { outbound: { qualityLimitation: "cpu" } },
      },
    },
  };

  const limited = updateSeatDiagnostics(health, new Map(), 2_000);
  assert.equal(limited.rows[1].state, "warning");
  assert.equal(limited.rows[1].stateLabel, "Return encoder cpu");
  assert.equal(limited.rows[1].qualityLimitation, "return: cpu");

  const stale = updateSeatDiagnostics(health, limited.nextBySeat, 7_000);
  assert.equal(stale.rows[1].state, "stale");
  assert.equal(stale.rows[1].statsAgeSeconds, 6);
});
