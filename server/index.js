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
  if (!config.tlsCertFile && config.host !== "127.0.0.1") {
    throw new Error("Plaintext primary listener must bind to 127.0.0.1");
  }
  const router = new FrameRouter(config);
  router.logger = logger;
  let shuttingDown = false;
  const localHttpEnabled = config.localHttpEnabled ?? false;
  const localHttpHost = config.localHttpHost ?? "127.0.0.1";
  if (localHttpEnabled && localHttpHost !== "127.0.0.1") {
    throw new Error("Local plaintext listener must bind to 127.0.0.1");
  }

  const getHealth = () => ({
    ok: !shuttingDown,
    status: shuttingDown ? "stopping" : "running",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    transport: config.tlsCertFile ? "https/wss" : "http/ws",
    localHttp: localHttpEnabled
      ? { enabled: true, host: localHttpHost, port: localServer?.address()?.port ?? config.localHttpPort }
      : { enabled: false },
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
  const localServer = localHttpEnabled ? createHttpServer(handler) : null;
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });

  function attachUpgradeHandler(httpServer) {
    httpServer.on("upgrade", (request, socket, head) => {
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
  }
  attachUpgradeHandler(server);
  if (localServer) attachUpgradeHandler(localServer);

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
    const listen = (httpServer, port, host) => new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, host);
    });

    await listen(server, config.port, config.host);
    if (localServer) {
      try {
        await listen(localServer, config.localHttpPort, localHttpHost);
      } catch (error) {
        await new Promise((resolve) => server.close(() => resolve()));
        throw error;
      }
    }
    return server.address();
  }

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    router.closeAll();
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise((resolve) => webSockets.close(() => resolve()));
    const closeServer = (httpServer) => {
      if (!httpServer?.listening) return Promise.resolve();
      return new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    };
    await Promise.all([closeServer(server), closeServer(localServer)]);
  }

  return { server, localServer, webSockets, router, getHealth, start, close, config };
}

async function main() {
  const runtime = createInternetCafeServer();
  const address = await runtime.start();
  const protocol = runtime.config.tlsCertFile ? "https" : "http";
  const host = runtime.config.host === "0.0.0.0" ? "localhost" : runtime.config.host;
  const port = typeof address === "object" && address ? address.port : runtime.config.port;
  console.log(`Internetcafe Influencer listening on ${protocol}://${host}:${port}`);
  if (runtime.localServer) {
    const localAddress = runtime.localServer.address();
    const localPort = typeof localAddress === "object" && localAddress
      ? localAddress.port
      : runtime.config.localHttpPort;
    console.log(`TouchDesigner bridge listening on http://127.0.0.1:${localPort}`);
  }
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
