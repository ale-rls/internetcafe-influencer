import { timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";

const PROTOCOL = "internetcafe.comments";
const PROTOCOL_VERSION = 1;
const STATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

function sameToken(actual, expected) {
  if (!expected) return true;
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function canonicalComment(message, stationId) {
  if (
    message?.protocol !== PROTOCOL
    || message?.version !== PROTOCOL_VERSION
    || message?.type !== "comment"
    || message?.stationId !== stationId
  ) return null;

  if (typeof message.id !== "string" || !COMMENT_ID_PATTERN.test(message.id)) return null;
  if (typeof message.sender !== "string" || message.sender.length < 1 || message.sender.length > 32) return null;
  if (typeof message.message !== "string" || message.message.length < 1 || message.message.length > 280) return null;
  if (!Number.isSafeInteger(message.sentAt) || message.sentAt < 0) return null;
  if (!Number.isSafeInteger(message.receivedAt) || message.receivedAt < 0) return null;

  return {
    id: message.id,
    sender: message.sender,
    message: message.message,
    receivedAt: message.receivedAt,
  };
}

export class CommentRelayReceiver {
  constructor({ sharedToken = null, helloTimeoutMs = 5_000, broadcastComment, logger = console } = {}) {
    this.sharedToken = sharedToken;
    this.helloTimeoutMs = helloTimeoutMs;
    this.broadcastComment = broadcastComment;
    this.logger = logger;
    this.clients = new Map();
    this.stations = new Map();
    this.lastConnectedAt = null;
    this.lastCommentAt = null;
    this.rejectedConnections = 0;
    this.counters = {
      received: 0,
      accepted: 0,
      rejected: 0,
      deliveredToPhones: 0,
      acceptedWithoutPhones: 0,
    };
  }

  attach(socket) {
    const client = { socket, stationId: null };
    this.clients.set(socket, client);
    const helloTimer = setTimeout(() => {
      if (!client.stationId && socket.readyState === WebSocket.OPEN) {
        this.reject(client, "hello timeout");
      }
    }, this.helloTimeoutMs);
    helloTimer.unref?.();

    socket.on("message", (data, isBinary) => {
      if (isBinary) return this.reject(client, "comment relay accepts JSON text only");
      if (!client.stationId) return this.register(client, data);
      return this.receiveComment(client, data);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.unregister(client);
    });
    socket.on("error", (error) => {
      this.logger.warn?.(`[comments] relay error: ${error.message}`);
    });
  }

  parse(rawData, invalidReason, client, category = "relay") {
    try {
      return JSON.parse(rawData.toString("utf8"));
    } catch {
      this.reject(client, invalidReason, category);
      return undefined;
    }
  }

  register(client, rawData) {
    const hello = this.parse(rawData, "invalid hello JSON", client);
    if (hello === undefined) return;
    const valid = hello.protocol === PROTOCOL
      && hello.version === PROTOCOL_VERSION
      && hello.type === "hello"
      && hello.role === "comment-relay"
      && typeof hello.stationId === "string"
      && STATION_PATTERN.test(hello.stationId)
      && sameToken(hello.token, this.sharedToken);
    if (!valid) return this.reject(client, "invalid comment relay hello");

    const previous = this.stations.get(hello.stationId);
    if (previous && previous !== client) {
      previous.socket.close(4001, "replaced by a newer relay connection");
      this.clients.delete(previous.socket);
    }
    client.stationId = hello.stationId;
    this.stations.set(client.stationId, client);
    this.lastConnectedAt = Date.now();
    this.logger.info?.(`[comments] relay connected: ${client.stationId}`);
  }

  receiveComment(client, rawData) {
    this.counters.received += 1;
    const message = this.parse(rawData, "invalid comment JSON", client, "comment");
    if (message === undefined) return;
    const comment = canonicalComment(message, client.stationId);
    if (!comment) return this.reject(client, "invalid canonical comment", "comment");

    const delivered = this.broadcastComment?.(comment) ?? 0;
    this.counters.accepted += 1;
    this.counters.deliveredToPhones += delivered;
    if (delivered === 0) this.counters.acceptedWithoutPhones += 1;
    this.lastCommentAt = Date.now();
  }

  reject(client, reason, category = "relay") {
    if (category === "comment") this.counters.rejected += 1;
    else this.rejectedConnections += 1;
    client.socket.close(1008, reason.slice(0, 123));
  }

  unregister(client) {
    this.clients.delete(client.socket);
    if (client.stationId && this.stations.get(client.stationId) === client) {
      this.stations.delete(client.stationId);
    }
  }

  snapshot() {
    return {
      commentRelay: {
        connected: this.stations.size > 0,
        connections: this.clients.size,
        stationIds: [...this.stations.keys()].sort(),
        lastConnectedAt: this.lastConnectedAt,
        lastCommentAt: this.lastCommentAt,
        rejectedConnections: this.rejectedConnections,
      },
      comments: { ...this.counters },
    };
  }

  closeAll(code = 1001, reason = "server shutting down") {
    for (const client of this.clients.values()) client.socket.close(code, reason);
    this.clients.clear();
    this.stations.clear();
  }
}
