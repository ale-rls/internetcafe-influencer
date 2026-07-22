import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { FrameRouter } from "./frame-router.js";
import { createQrPage } from "./qr.js";
import { createRequestHandler } from "./static.js";

export function createInternetCafeServer(config = loadConfig(), { logger = console } = {}) {
  const startedAt = Date.now();
  const router = new FrameRouter(config);
  router.logger = logger;
  let shuttingDown = false;

  const getHealth = () => ({
    ok: !shuttingDown,
    status: shuttingDown ? "stopping" : "running",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    transport: config.tlsCertFile ? "https/wss" : "http/ws",
    phoneBaseUrl: config.phoneBaseUrl,
    websocketPaths: ["/", "/stream"],
    ...router.snapshot(),
  });
  const handler = createRequestHandler({
    publicDir: config.publicDir,
    getHealth,
    getQrPage: (seat) => createQrPage({ phoneBaseUrl: config.phoneBaseUrl, seat }),
  });
  const server = config.tlsCertFile
    ? createHttpsServer(
        { cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile) },
        handler,
      )
    : createHttpServer(handler);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });

  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/" && pathname !== "/stream") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit("connection", client, request);
    });
  });

  webSockets.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
    router.attach(socket);
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  async function start() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server.address();
  }

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    router.closeAll();
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise((resolve) => webSockets.close(() => resolve()));
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return { server, webSockets, router, getHealth, start, close, config };
}

async function main() {
  const runtime = createInternetCafeServer();
  const address = await runtime.start();
  const protocol = runtime.config.tlsCertFile ? "https" : "http";
  const host = runtime.config.host === "0.0.0.0" ? "localhost" : runtime.config.host;
  const port = typeof address === "object" && address ? address.port : runtime.config.port;
  console.log(`Internetcafe Influencer listening on ${protocol}://${host}:${port}`);
  if (runtime.config.phoneBaseUrl) console.log(`Phone URL base: ${runtime.config.phoneBaseUrl}`);

  const shutdown = async (signal) => {
    console.log(`${signal} received; shutting down`);
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
