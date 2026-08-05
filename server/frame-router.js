import { WebSocket } from "ws";

const ROLES = new Set([
  "phone",
  "decoder",
  "touch-output",
  "tracking-source",
  "tracking-sink",
]);
const BINARY_TARGET_ROLE = new Map([
  ["phone", "decoder"],
  ["touch-output", "phone"],
  ["tracking-source", "tracking-sink"],
]);
const SEAT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function blankCounters() {
  return {
    receivedFrames: 0,
    receivedBytes: 0,
    forwardedFrames: 0,
    forwardedBytes: 0,
    droppedNoDestination: 0,
    droppedBackpressure: 0,
    rejectedMessages: 0,
    replacedConnections: 0,
    forwardedControlMessages: 0,
    droppedControlNoDestination: 0,
    rateLimitedFilterSteps: 0,
    replayedLiveComments: 0,
  };
}

export class FrameRouter {
  constructor({
    maxBufferedBytes = 1024 * 1024,
    helloTimeoutMs = 5_000,
    filterStepIntervalMs = 150,
    commentReplayLimit = 6,
    commentReplayMaxAgeMs = 120_000,
    logger = console,
  } = {}) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.helloTimeoutMs = helloTimeoutMs;
    this.filterStepIntervalMs = filterStepIntervalMs;
    this.commentReplayLimit = commentReplayLimit;
    this.commentReplayMaxAgeMs = commentReplayMaxAgeMs;
    this.logger = logger;
    this.seats = new Map();
    this.controlStates = new Map();
    this.lastFilterStepBySeat = new Map();
    this.commentReplayAfterBySeat = new Map();
    this.recentComments = [];
    this.clients = new Map();
    this.counters = blankCounters();
  }

  attach(socket) {
    const client = { socket, role: null, seat: null, connectedAt: Date.now() };
    this.clients.set(socket, client);

    const helloTimer = setTimeout(() => {
      if (!client.role && socket.readyState === WebSocket.OPEN) {
        this.reject(socket, "hello timeout");
      }
    }, this.helloTimeoutMs);
    helloTimer.unref?.();

    socket.on("message", (data, isBinary) => this.onMessage(client, data, isBinary));
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.unregister(client);
    });
    socket.on("error", (error) => {
      this.logger.warn?.(`[ws] client error: ${error.message}`);
    });
  }

  onMessage(client, data, isBinary) {
    if (!client.role) {
      if (isBinary) return this.reject(client.socket, "first message must be hello JSON");
      return this.register(client, data);
    }

    if (!isBinary) return this.handleTextMessage(client, data);

    const targetRole = BINARY_TARGET_ROLE.get(client.role);
    if (!targetRole) return this.reject(client.socket, `${client.role} is receive-only`);

    this.counters.receivedFrames += 1;
    this.counters.receivedBytes += data.byteLength;
    const target = this.seats.get(client.seat)?.get(targetRole)?.socket;

    if (!target || target.readyState !== WebSocket.OPEN) {
      this.counters.droppedNoDestination += 1;
      return;
    }

    // Do not let ws build a delayed video queue. A future source frame is more
    // useful than an old one, so frames are dropped while a write is buffered.
    if (target.bufferedAmount > 0 || target.bufferedAmount + data.byteLength > this.maxBufferedBytes) {
      this.counters.droppedBackpressure += 1;
      return;
    }

    target.send(data, { binary: true }, (error) => {
      if (error) this.logger.warn?.(`[ws] frame send failed: ${error.message}`);
    });
    this.counters.forwardedFrames += 1;
    this.counters.forwardedBytes += data.byteLength;
  }

  handleTextMessage(client, rawData) {
    let message;
    try {
      message = JSON.parse(rawData.toString("utf8"));
    } catch {
      return this.reject(client.socket, "invalid message JSON");
    }

    if (client.role === "phone" && message?.type === "camera-info") {
      return this.handleCameraInfo(client, message);
    }
    if (client.role === "phone" && message?.type === "filter-step") {
      return this.handleFilterStep(client, message);
    }
    if (client.role === "touch-output" && message?.type === "live-ui-state") {
      return this.handleLiveUiState(client, message);
    }
    if (
      (client.role === "tracking-sink" || client.role === "touch-output")
      && message?.type === "filter-state"
    ) {
      return this.handleFilterState(client, message);
    }
    return this.reject(client.socket, `${client.role} cannot send this text message`);
  }

  handleCameraInfo(client, message) {
    const sourceWidth = Number(message.source?.width);
    const sourceHeight = Number(message.source?.height);
    if (
      !Number.isInteger(sourceWidth)
      || !Number.isInteger(sourceHeight)
      || sourceWidth < 1
      || sourceHeight < 1
      || sourceWidth > 16_384
      || sourceHeight > 16_384
    ) {
      return this.reject(client.socket, "camera-info requires valid source dimensions");
    }

    const optionalNumber = (value, max = 16_384) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
    };
    const optionalString = (value, maxLength = 240) => (
      typeof value === "string" ? value.slice(0, maxLength) : null
    );

    client.camera = {
      source: { width: sourceWidth, height: sourceHeight },
      track: {
        width: optionalNumber(message.track?.width),
        height: optionalNumber(message.track?.height),
        aspectRatio: optionalNumber(message.track?.aspectRatio, 10),
        frameRate: optionalNumber(message.track?.frameRate, 240),
        resizeMode: optionalString(message.track?.resizeMode, 32),
        facingMode: optionalString(message.track?.facingMode, 32),
      },
      output: {
        width: optionalNumber(message.output?.width),
        height: optionalNumber(message.output?.height),
      },
      viewport: {
        width: optionalNumber(message.viewport?.width),
        height: optionalNumber(message.viewport?.height),
        devicePixelRatio: optionalNumber(message.viewport?.devicePixelRatio, 10),
        orientation: optionalString(message.viewport?.orientation, 64),
      },
      userAgent: optionalString(message.userAgent),
      receivedAt: Date.now(),
    };
  }

  handleFilterStep(client, message) {
    if (message.delta !== -1 && message.delta !== 1) {
      return this.reject(client.socket, "filter-step delta must be -1 or 1");
    }
    const now = Date.now();
    const previousStepAt = this.lastFilterStepBySeat.get(client.seat);
    if (previousStepAt && now - previousStepAt < this.filterStepIntervalMs) {
      this.counters.rateLimitedFilterSteps += 1;
      return;
    }
    this.lastFilterStepBySeat.set(client.seat, now);
    this.sendTextToRole(client.seat, "tracking-sink", { type: "filter-step", delta: message.delta });
  }

  handleLiveUiState(client, message) {
    if (typeof message.enabled !== "boolean") {
      return this.reject(client.socket, "live-ui-state enabled must be boolean");
    }
    const state = this.controlState(client.seat);
    const previouslyEnabled = state.liveUi?.enabled;
    state.liveUi = { type: "live-ui-state", enabled: message.enabled };
    if (previouslyEnabled === false && message.enabled) {
      this.commentReplayAfterBySeat.set(client.seat, Date.now());
    }
    this.sendTextToRole(client.seat, "phone", state.liveUi);
  }

  handleFilterState(client, message) {
    const index = message.index;
    const count = message.count;
    const validName = message.name === undefined
      || (typeof message.name === "string" && message.name.length <= 80);
    if (
      !Number.isSafeInteger(index)
      || !Number.isSafeInteger(count)
      || count < 1
      || index < 0
      || index >= count
      || !validName
    ) {
      return this.reject(client.socket, "filter-state requires a valid index, count, and optional name");
    }
    const state = this.controlState(client.seat);
    state.filter = {
      type: "filter-state",
      index,
      count,
      ...(message.name ? { name: message.name } : {}),
    };
    this.sendTextToRole(client.seat, "phone", state.filter);
  }

  controlState(seat) {
    let state = this.controlStates.get(seat);
    if (!state) {
      state = {};
      this.controlStates.set(seat, state);
    }
    return state;
  }

  sendTextToRole(seat, role, message) {
    const target = this.seats.get(String(seat))?.get(role)?.socket;
    if (!target || target.readyState !== WebSocket.OPEN) {
      this.counters.droppedControlNoDestination += 1;
      return false;
    }
    target.send(JSON.stringify(message), { binary: false }, (error) => {
      if (error) this.logger.warn?.(`[ws] control send failed for seat ${seat}: ${error.message}`);
    });
    this.counters.forwardedControlMessages += 1;
    return true;
  }

  register(client, rawData) {
    let hello;
    try {
      hello = JSON.parse(rawData.toString("utf8"));
    } catch {
      return this.reject(client.socket, "invalid hello JSON");
    }

    const role = hello?.type === "hello" ? hello.role : null;
    const seat = typeof hello?.seat === "number" ? String(hello.seat) : hello?.seat;
    if (!ROLES.has(role) || typeof seat !== "string" || !SEAT_PATTERN.test(seat)) {
      return this.reject(
        client.socket,
        "hello requires a supported role and a valid seat",
      );
    }

    let seatClients = this.seats.get(seat);
    if (!seatClients) {
      seatClients = new Map();
      this.seats.set(seat, seatClients);
    }

    const previous = seatClients.get(role);
    if (previous && previous.socket !== client.socket) {
      this.counters.replacedConnections += 1;
      previous.socket.close(4001, "replaced by a newer connection");
      this.clients.delete(previous.socket);
    }

    client.role = role;
    client.seat = seat;
    seatClients.set(role, client);
    client.socket.send(JSON.stringify({ type: "hello-ack", role, seat }));
    if (role === "phone") {
      const state = this.controlStates.get(seat);
      if (state?.liveUi) this.sendTextToRole(seat, "phone", state.liveUi);
      if (state?.filter) this.sendTextToRole(seat, "phone", state.filter);
      this.replayRecentComments(seat);
    }
    this.logger.info?.(`[ws] ${role} connected for seat ${seat}`);
  }

  reject(socket, reason) {
    this.counters.rejectedMessages += 1;
    socket.close(1008, reason.slice(0, 123));
  }

  sendNotification(notification, seats) {
    const payload = JSON.stringify({
      type: "notification",
      app: notification.app,
      sender: notification.sender,
      message: notification.message,
      durationMs: 5_000,
      sentAt: Date.now(),
    });
    const deliveredSeats = [];
    const missingSeats = [];

    for (const seat of seats) {
      const target = this.seats.get(String(seat))?.get("phone")?.socket;
      if (!target || target.readyState !== WebSocket.OPEN) {
        missingSeats.push(String(seat));
        continue;
      }

      target.send(payload, { binary: false }, (error) => {
        if (error) this.logger.warn?.(`[ws] notification send failed for seat ${seat}: ${error.message}`);
      });
      deliveredSeats.push(String(seat));
    }

    return { deliveredSeats, missingSeats };
  }

  broadcastLiveComment(comment) {
    const payload = this.liveCommentPayload(comment);
    const acceptedAt = Date.now();
    this.recentComments.push({ comment: structuredClone(comment), acceptedAt });
    this.pruneRecentComments(acceptedAt);
    let delivered = 0;
    for (const [seat, clients] of this.seats) {
      const target = clients.get("phone")?.socket;
      if (!target || target.readyState !== WebSocket.OPEN) continue;
      target.send(payload, { binary: false }, (error) => {
        if (error) this.logger.warn?.(`[comments] phone send failed for seat ${seat}: ${error.message}`);
      });
      delivered += 1;
    }
    return delivered;
  }

  liveCommentPayload(comment) {
    return JSON.stringify({
      type: "live-comment",
      id: comment.id,
      sender: comment.sender,
      message: comment.message,
      receivedAt: comment.receivedAt,
    });
  }

  pruneRecentComments(now = Date.now()) {
    const cutoff = now - this.commentReplayMaxAgeMs;
    this.recentComments = this.recentComments
      .filter(({ acceptedAt }) => acceptedAt >= cutoff)
      .slice(-this.commentReplayLimit);
  }

  replayRecentComments(seat) {
    const state = this.controlStates.get(seat);
    if (state?.liveUi?.enabled === false) return 0;

    this.pruneRecentComments();
    const replayAfter = this.commentReplayAfterBySeat.get(seat) ?? 0;
    let replayed = 0;
    for (const entry of this.recentComments) {
      if (entry.acceptedAt < replayAfter) continue;
      if (!this.sendTextToRole(seat, "phone", JSON.parse(this.liveCommentPayload(entry.comment)))) break;
      replayed += 1;
    }
    this.counters.replayedLiveComments += replayed;
    return replayed;
  }

  unregister(client) {
    this.clients.delete(client.socket);
    if (!client.role || !client.seat) return;
    const seatClients = this.seats.get(client.seat);
    if (seatClients?.get(client.role) === client) seatClients.delete(client.role);
    if (seatClients?.size === 0) this.seats.delete(client.seat);
  }

  snapshot() {
    const seats = {};
    const cameras = {};
    const controlStates = {};
    for (const [seat, clients] of this.seats) {
      seats[seat] = Object.fromEntries(
        [...ROLES].map((role) => [role, clients.get(role)?.socket.readyState === WebSocket.OPEN]),
      );
      const phone = clients.get("phone");
      if (phone?.camera) cameras[seat] = structuredClone(phone.camera);
    }
    for (const [seat, state] of this.controlStates) {
      controlStates[seat] = structuredClone(state);
    }
    return {
      connections: this.clients.size,
      registeredConnections: [...this.seats.values()].reduce((sum, clients) => sum + clients.size, 0),
      seats,
      cameras,
      controlStates,
      counters: { ...this.counters },
    };
  }

  closeAll(code = 1001, reason = "server shutting down") {
    for (const client of this.clients.values()) client.socket.close(code, reason);
    this.clients.clear();
    this.seats.clear();
    this.controlStates.clear();
    this.lastFilterStepBySeat.clear();
    this.commentReplayAfterBySeat.clear();
    this.recentComments = [];
  }
}
