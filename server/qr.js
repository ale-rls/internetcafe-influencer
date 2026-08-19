import QRCode from "qrcode";

export const DEFAULT_SEAT = 1;
const PHONE_PATH = "/phone/";

function parseSeat(seat) {
  const value = typeof seat === "number" ? seat : Number(seat);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("seat must be a positive integer");
  }
  return value;
}

function isLocalhost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Validates the explicitly configured public base URL used by phones.
 * It intentionally has no fallback: a QR code must never point a phone at a
 * server-side localhost address by accident.
 */
export function publicPhoneBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("PHONE_BASE_URL is required to render a phone QR code");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("PHONE_BASE_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PHONE_BASE_URL must use http or https");
  }
  if (url.username || url.password || isLocalhost(url.hostname)) {
    throw new Error("PHONE_BASE_URL must be a public URL, not localhost or a credentialed URL");
  }
  return url;
}

/**
 * Builds the exact phone route under the configured base URL. Existing query
 * parameters and fragments are deliberately not copied into a scannable URL.
 */
export function phoneUrlForSeat(phoneBaseUrl, seat = DEFAULT_SEAT) {
  const base = publicPhoneBaseUrl(phoneBaseUrl);
  const seatNumber = parseSeat(seat);
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}${PHONE_PATH}`;
  base.search = "";
  base.searchParams.set("seat", String(seatNumber));
  base.searchParams.set("transport", "webrtc");
  base.hash = "";
  return base.toString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Pure HTML wrapper, kept separate from QR encoding for straightforward tests. */
export function renderQrHtml({ phoneUrl, qrSvg, seat = DEFAULT_SEAT }) {
  const seatNumber = parseSeat(seat);
  if (typeof phoneUrl !== "string" || phoneUrl === "") throw new Error("phoneUrl is required");
  if (typeof qrSvg !== "string" || qrSvg === "") throw new Error("qrSvg is required");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect phone — seat ${seatNumber}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    body { align-items: center; background: #f7f7f5; color: #171717; display: grid; margin: 0; min-height: 100vh; padding: 1.5rem; }
    main { background: #fff; border-radius: 1rem; box-shadow: 0 .5rem 2rem #0002; max-width: 30rem; padding: 2rem; text-align: center; width: min(100%, 30rem); }
    .qr svg { display: block; height: auto; margin: 1.5rem auto; max-width: 100%; width: 18rem; }
    code { display: block; font-size: .8rem; overflow-wrap: anywhere; }
  </style>
</head>
<body><main>
  <p>Seat ${seatNumber}</p>
  <h1>Connect your phone</h1>
  <p>Scan this code to open the controller.</p>
  <div class="qr" aria-label="QR code for phone controller">${qrSvg}</div>
  <p>Or open this address:</p>
  <code>${escapeHtml(phoneUrl)}</code>
</main></body>
</html>`;
}

/** Generates a complete QR page. No grants, tokens, or rotating state are involved. */
export async function createQrPage({ phoneBaseUrl, seat = DEFAULT_SEAT, toSvg = QRCode.toString } = {}) {
  const seatNumber = parseSeat(seat);
  const phoneUrl = phoneUrlForSeat(phoneBaseUrl, seatNumber);
  const qrSvg = await toSvg(phoneUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  });
  return { phoneUrl, qrSvg, html: renderQrHtml({ phoneUrl, qrSvg, seat: seatNumber }) };
}
