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

function resolveAsset(publicDir, pathname) {
  const routeFiles = {
    "/phone": "phone/index.html",
    "/phone/": "phone/index.html",
    "/decoder": "decoder/index.html",
    "/decoder/": "decoder/index.html",
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

export function createRequestHandler({ publicDir, getHealth, getQrPage }) {
  const root = resolve(publicDir);
  return (request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", "http://localhost");
    } catch {
      return sendJson(response, 400, { error: "invalid URL" });
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
    if (url.pathname === "/phone" || url.pathname === "/decoder" || url.pathname === "/qr") {
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
