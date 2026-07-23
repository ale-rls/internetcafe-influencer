# Internetcafe Influencer

Minimal one-phone prototype for this round trip:

```text
phone camera -> terminal WebSocket server -> TouchDesigner Web Render TOP
             <- terminal WebSocket server <- processed TouchDesigner TOP
```

The terminal process owns the web app, QR page, HTTPS, connection registry,
and binary frame routing. TouchDesigner remains an image processor and a
WebSocket client. Frames are 512x512 JPEGs at an initial target of 10 fps;
backpressured frames are dropped instead of queued.

With TLS configured, the process starts two listeners that share the same
pages, WebSocket registry, and frame router:

- `https://0.0.0.0:8443` / `wss://...` for phones on the LAN.
- `http://127.0.0.1:8080` / `ws://127.0.0.1:8080` for TouchDesigner on the
  same machine.

The plaintext listener is optional and is hard-limited to loopback; it cannot
be exposed to the LAN by configuration.

## Requirements

- Node.js 22 or newer
- pnpm 9.12.2 (Corepack can provide it)
- Phone and terminal on the same LAN
- Trusted HTTPS for phone camera access

## Install

```sh
corepack enable
pnpm install
cp .env.example .env
```

Configure the LAN address and certificate paths in `.env`, following
[HTTPS_SETUP.md](HTTPS_SETUP.md), then run:

```sh
pnpm start
```

Open these routes:

- `/qr/?seat=1` - scannable phone connection page
- `/qrcode` - short alias for the seat 1 QR page
- `/phone/?seat=1` - phone camera sender and processed-frame viewer
- `/decoder/?seat=1` - canvas captured by TouchDesigner Web Render TOP
- `/healthz` - connection, routing, and frame counters
- `/stream` - binary WebSocket endpoint

The first JSON message on every WebSocket registers one role and seat. Binary
frames then route `phone -> decoder` and `touch-output -> phone`.

## TouchDesigner

See the [TouchDesigner file index](touchdesigner/README.md). Build the original
[standalone network](touchdesigner/docs/v1-standalone.md), or use the reusable
[`PhoneSender` Base](touchdesigner/docs/v2-phone-sender.md). The original
standalone callbacks and the Base-specific callbacks are kept as separate
files.

## Test

```sh
pnpm test
```

See [TESTING.md](TESTING.md) for the desktop socket smoke test and the physical
phone/TouchDesigner acceptance sequence.

## Scope

This first milestone intentionally excludes five-seat orchestration, WebRTC,
audio, authentication, rotating grants, StreamDiffusion, and light-ring
control. It proves the local browser-to-TouchDesigner image round trip first.
