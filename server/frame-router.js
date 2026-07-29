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
  };
}

export class FrameRouter {
  constructor({ maxBufferedBytes = 1024 * 1024, helloTimeoutMs = 5_000, logger = console } = {}) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.helloTimeoutMs = helloTimeoutMs;
    this.logger = logger;
    this.seats = new Map();
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

    if (client.role !== "phone" || message?.type !== "camera-info") {
      return this.reject(client.socket, "only phone camera-info text is allowed after hello");
    }

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
    for (const [seat, clients] of this.seats) {
      seats[seat] = Object.fromEntries(
        [...ROLES].map((role) => [role, clients.get(role)?.socket.readyState === WebSocket.OPEN]),
      );
      const phone = clients.get("phone");
      if (phone?.camera) cameras[seat] = structuredClone(phone.camera);
    }
    return {
      connections: this.clients.size,
      registeredConnections: [...this.seats.values()].reduce((sum, clients) => sum + clients.size, 0),
      seats,
      cameras,
      counters: { ...this.counters },
    };
  }

  closeAll(code = 1001, reason = "server shutting down") {
    for (const client of this.clients.values()) client.socket.close(code, reason);
    this.clients.clear();
    this.seats.clear();
  }
}
