# Testing and acceptance checklist

## Automated checks

Install the declared dependencies once, then run the Node built-in test runner:

```sh
pnpm install
pnpm test
```

The tests cover the public QR URL contract, QR rendering boundary, static and
health routes, one-seat WebSocket routing/replacement, tracking packet encoding
and routing, MediaPipe asset delivery, and the router's backpressure-drop
policy. They do not need a camera, a real QR scan, or TouchDesigner.

## Desktop two-client smoke test

This is the quickest end-to-end check of the server before involving a phone.
Use a hostname/IP that the participating clients can reach. For a phone camera,
use a trusted HTTPS URL and the matching TLS settings; browsers generally do
not allow `getUserMedia()` over plain HTTP on a remote device.

```sh
TLS_CERT_FILE=/path/to/fullchain.pem \
TLS_KEY_FILE=/path/to/privkey.pem \
PHONE_BASE_URL=https://YOUR_PUBLIC_HOST \
pnpm start
```

1. In desktop browser A, open `https://YOUR_PUBLIC_HOST/decoder/?seat=1`.
   It should show “Waiting for JPEG frames…” after connecting.
2. In desktop browser B, open `https://YOUR_PUBLIC_HOST/phone/?seat=1` and
   select **Start camera**. Allow the camera permission. It should report a
   live connection and show nonzero uplink FPS.
3. Confirm the server’s `https://YOUR_PUBLIC_HOST/healthz` reports three or
   fewer registered clients as expected and a `seats["1"]` entry. At this stage
   the decoder will have no return image until TouchDesigner sends one.
4. Open a second phone page for seat 1. The original phone WebSocket should be
   replaced (close code 4001); `/healthz` should still show one `phone` role for
   seat 1. Close the second tab and refresh the original if you want it active.
5. Open `https://YOUR_PUBLIC_HOST/qr/?seat=1`, scan it, and verify the phone
   lands on `https://YOUR_PUBLIC_HOST/phone/?seat=1` rather than a localhost URL.

For a local desktop-only check, omit the TLS variables and use
`PHONE_BASE_URL=http://LAN_HOST:8080`; do not use that form for remote mobile
camera acceptance.

## TouchDesigner and phone round-trip acceptance

Follow [touchdesigner/docs/v1-standalone.md](touchdesigner/docs/v1-standalone.md) to construct the listed
operators and load the supplied callback DAT files. Then verify, in order:

- `web_render1` loads `/decoder/?seat=1` and the decoder WebSocket connects.
- `ws_output` connects to the same server and `td_status` confirms the
  `touch-output` hello for seat 1.
- With `test_switch` on its `test_pattern` input, `send_timer` produces one
  `td_status` “Sent JPEG” update every ~0.1 seconds; `/healthz` increments
  received and forwarded frame counters without persistent backpressure drops.
- The desktop/phone decoder view visibly receives the changing pattern from
  TouchDesigner, proving the TouchDesigner → server → phone path.
- Start the phone camera and verify TouchDesigner’s `web_render1` / `decoded_in`
  visibly updates from it, proving the phone → server → decoder page → Web
  Render TOP path.
- Switch `test_switch` to `decoded_in`; `processed_out` should now contain the
  decoder-rendered image and the phone should display the returned round trip.
- Disconnect the phone or stop the server. The browser reconnect indicators and
  the `td_status`/`td_errors` DATs must make the failure visible; no silent
  retry should continue sending JPEG bytes while disconnected.

Record browser/device, URL, certificate state, and observed frame rates with
any acceptance failure. A single-seat prototype intentionally replaces a newer
connection for the same role and seat; this is not a multi-user session test.

## Browser face-tracking acceptance

Follow [touchdesigner/docs/browser-face-tracking.md](touchdesigner/docs/browser-face-tracking.md)
to add `ws_tracking` and `tracking_landmarks`, then verify:

- `/healthz` shows `tracking-source: true` after the decoder page loads and
  `tracking-sink: true` after the TouchDesigner WebSocket DAT activates.
- The decoder page continues painting while MediaPipe initializes; a tracking
  failure must not interrupt the phone image.
- `ws_tracking.fetch('tracking_landmark_count', 0)` reports 478 when a face is
  visible and returns to 0 when the face leaves the frame.
- `tracking_landmarks` contains 479 samples in channels `x` and `y`: 478
  MediaPipe landmarks followed by one compatibility-padding sample for the
  artist's hardcoded landmark-texture width.
- The existing CHOP to TOP remains floating point and the GLSL overlay aligns
  at the center and edges of the 512x512 image.
- If landmarks consistently trail the image, measure the offset and add only
  that many frames of Cache TOP delay to the video path.
