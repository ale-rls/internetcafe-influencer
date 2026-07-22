import { WebSocket } from "ws";

const ROLES = new Set(["phone", "decoder", "touch-output"]);
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

    if (!isBinary) return this.reject(client.socket, "only binary frames are allowed after hello");
    if (client.role === "decoder") return this.reject(client.socket, "decoder is receive-only");

    this.counters.receivedFrames += 1;
    this.counters.receivedBytes += data.byteLength;
    const targetRole = client.role === "phone" ? "decoder" : "phone";
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
      return this.reject(client.socket, "hello requires role phone|decoder|touch-output and a valid seat");
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

  unregister(client) {
    this.clients.delete(client.socket);
    if (!client.role || !client.seat) return;
    const seatClients = this.seats.get(client.seat);
    if (seatClients?.get(client.role) === client) seatClients.delete(client.role);
    if (seatClients?.size === 0) this.seats.delete(client.seat);
  }

  snapshot() {
    const seats = {};
    for (const [seat, clients] of this.seats) {
      seats[seat] = Object.fromEntries(
        [...ROLES].map((role) => [role, clients.get(role)?.socket.readyState === WebSocket.OPEN]),
      );
    }
    return {
      connections: this.clients.size,
      registeredConnections: [...this.seats.values()].reduce((sum, clients) => sum + clients.size, 0),
      seats,
      counters: { ...this.counters },
    };
  }

  closeAll(code = 1001, reason = "server shutting down") {
    for (const client of this.clients.values()) client.socket.close(code, reason);
    this.clients.clear();
    this.seats.clear();
  }
}
