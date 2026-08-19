import assert from "node:assert/strict";
import test from "node:test";
import { createQrPage, phoneUrlForSeat, publicPhoneBaseUrl, renderQrHtml } from "../server/qr.js";

test("phoneUrlForSeat preserves a deployed path prefix and removes query/fragment", () => {
  assert.equal(
    phoneUrlForSeat("https://cafe.example/kiosk/?stale=yes#fragment", 7),
    "https://cafe.example/kiosk/phone/?seat=7&transport=webrtc",
  );
});

test("QR URLs require a public HTTP(S) base URL", () => {
  for (const value of [undefined, "", "relative/path", "ftp://cafe.example", "http://localhost:8080", "https://127.0.0.1", "https://user:pass@cafe.example"]) {
    assert.throws(() => publicPhoneBaseUrl(value), /PHONE_BASE_URL/);
  }
  assert.throws(() => phoneUrlForSeat("https://cafe.example", 0), /positive integer/);
  assert.throws(() => phoneUrlForSeat("https://cafe.example", "seat-a"), /positive integer/);
});

test("renderQrHtml escapes the displayed URL but preserves supplied SVG", () => {
  const html = renderQrHtml({
    phoneUrl: "https://cafe.example/phone/?label=<unsafe>&seat=1",
    qrSvg: '<svg aria-label="test"></svg>',
    seat: 1,
  });

  assert.match(html, /https:\/\/cafe\.example\/phone\/\?label=&lt;unsafe&gt;&amp;seat=1/);
  assert.match(html, /<svg aria-label="test"><\/svg>/);
});

test("createQrPage encodes the exact phone URL with the expected QR options", async () => {
  let captured;
  const page = await createQrPage({
    phoneBaseUrl: "https://cafe.example/demo",
    seat: 3,
    toSvg: async (value, options) => {
      captured = { value, options };
      return "<svg></svg>";
    },
  });

  assert.deepEqual(captured, {
    value: "https://cafe.example/demo/phone/?seat=3&transport=webrtc",
    options: { type: "svg", errorCorrectionLevel: "M", margin: 2 },
  });
  assert.equal(page.phoneUrl, captured.value);
  assert.match(page.html, /Connect your phone/);
});
