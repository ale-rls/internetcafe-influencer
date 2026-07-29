import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const CONTROL_SEATS = ["1", "2", "3", "4"];
const NOTIFICATION_APPS = new Set(["instagram", "whatsapp"]);
const MAX_NOTIFICATION_BODY_BYTES = 16 * 1024;

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHtml(request, response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_NOTIFICATION_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        rejectBody(Object.assign(new Error("request body is too large"), { statusCode: 413 }));
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", rejectBody);
  });
}

function notificationRequest(body) {
  const target = body?.seat === "all" ? "all" : String(body?.seat ?? "");
  const app = typeof body?.app === "string" ? body.app.toLowerCase() : "";
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (target !== "all" && !CONTROL_SEATS.includes(target)) {
    throw Object.assign(new Error("seat must be all or a number from 1 to 4"), { statusCode: 400 });
  }
  if (!NOTIFICATION_APPS.has(app)) {
    throw Object.assign(new Error("app must be instagram or whatsapp"), { statusCode: 400 });
  }
  if (!sender || sender.length > 60) {
    throw Object.assign(new Error("sender must contain 1 to 60 characters"), { statusCode: 400 });
  }
  if (!message || message.length > 280) {
    throw Object.assign(new Error("message must contain 1 to 280 characters"), { statusCode: 400 });
  }

  return {
    notification: { app, sender, message },
    seats: target === "all" ? CONTROL_SEATS : [target],
    target,
  };
}

function resolveAsset(publicDir, pathname) {
  const routeFiles = {
    "/phone": "phone/index.html",
    "/phone/": "phone/index.html",
    "/decoder": "decoder/index.html",
    "/decoder/": "decoder/index.html",
    "/control": "control/index.html",
    "/control/": "control/index.html",
    "/qr": "qr/index.html",
    "/qr/": "qr/index.html",
  };
  const relative = routeFiles[pathname] || pathname.replace(/^\/+/, "");
  const safeRelative = normalize(relative);
  const candidate = resolve(join(publicDir, safeRelative));
  if (candidate !== publicDir && !candidate.startsWith(publicDir + sep)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

export function createRequestHandler({ publicDir, getHealth, getQrPage, controlEnabled = false, sendNotification }) {
  const root = resolve(publicDir);
  return (request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://localhost");
    } catch {
      return sendJson(response, 400, { error: "invalid URL" });
    }

    const isControlPath = url.pathname === "/control"
      || url.pathname.startsWith("/control/")
      || url.pathname === "/api/notifications";
    if (isControlPath && !controlEnabled) return sendJson(response, 404, { error: "not found" });

    if (url.pathname === "/api/notifications") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        return sendJson(response, 405, { error: "method not allowed" });
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return sendJson(response, 415, { error: "content-type must be application/json" });
      }

      readJson(request).then((body) => {
        const { notification, seats, target } = notificationRequest(body);
        const delivery = sendNotification(notification, seats);
        sendJson(response, 200, { ok: true, target, ...delivery });
      }).catch((error) => {
        sendJson(response, error?.statusCode || 500, {
          error: error instanceof Error ? error.message : "notification could not be sent",
        });
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return sendJson(response, 405, { error: "method not allowed" });
    }
    if (url.pathname === "/healthz") return sendJson(response, 200, getHealth());
    if (url.pathname === "/") {
      response.writeHead(302, { location: "/qr/?seat=1", "cache-control": "no-store" });
      return response.end();
    }
    if (url.pathname === "/phone" || url.pathname === "/decoder" || url.pathname === "/qr" || url.pathname === "/control") {
      response.writeHead(308, {
        location: `${url.pathname}/${url.search}`,
        "cache-control": "no-store",
      });
      return response.end();
    }
    if (url.pathname === "/qr/" || url.pathname === "/qrcode" || url.pathname === "/qrcode/") {
      const seat = url.searchParams.get("seat") || "1";
      if (!/^[1-9]\d*$/.test(seat)) return sendJson(response, 400, { error: "seat must be a positive integer" });
      Promise.resolve(getQrPage(seat)).then(
        ({ html }) => sendHtml(request, response, 200, html),
        (error) => sendJson(response, 503, { error: error instanceof Error ? error.message : "QR unavailable" }),
      );
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(response, 400, { error: "invalid path encoding" });
    }
    const asset = resolveAsset(root, decodedPath);
    if (!asset) return sendJson(response, 404, { error: "not found" });
    const stat = statSync(asset);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(asset).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-store",
      "permissions-policy": "camera=(self)",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(asset).pipe(response);
  };
}
