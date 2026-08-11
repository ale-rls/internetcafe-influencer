# Internetcafe Influencer

Local seven-seat implementation of this round trip:

```text
phone camera -> terminal WebSocket server -> TouchDesigner Web Render TOP
             <- terminal WebSocket server <- processed TouchDesigner TOP
commenter    -> terminal comment relay    -> every connected influencer phone
```

The terminal process owns the web app, QR page, HTTPS, connection registry,
and binary frame routing. TouchDesigner remains an image processor and a
WebSocket client. Frames are 720x1280 portrait JPEGs; phone capture, WebRTC
return, and the v2 TouchDesigner return sender are capped at 24 fps. Backpressured
frames are dropped instead of queued.

With TLS configured, the process starts two listeners that share the same
pages, WebSocket registry, and frame router:

- `https://0.0.0.0:8443` / `wss://...` for phones on the LAN.
- `http://127.0.0.1:8080` / `ws://127.0.0.1:8080` for TouchDesigner on the
  same machine.

The plaintext listener is optional and is hard-limited to loopback; it cannot
be exposed to the LAN by configuration.

## Requirements

- Windows 10 or 11 (the detailed setup below uses PowerShell)
- Node.js 22 or newer
- pnpm 9.12.2 (Corepack can provide it)
- [mkcert](https://github.com/FiloSottile/mkcert) for a locally trusted certificate
- Phone and terminal on the same LAN
- Trusted HTTPS for phone camera access

## Install on a new Windows computer

The certificate and `.env` file are intentionally not included in the
repository. They contain machine-specific paths, addresses, and a private key,
so every new computer must create its own copies.

### 1. Copy the project and install dependencies

Install Node.js 22 or newer, open PowerShell in the project directory, and
run:

```powershell
node --version
corepack enable
corepack prepare pnpm@9.12.2 --activate
pnpm install --frozen-lockfile
```

If `corepack` is missing, install it first with
`npm install --global corepack`.

### 2. Find the computer's LAN address

```powershell
ipconfig
```

Use the `IPv4 Address` belonging to the active Ethernet or Wi-Fi adapter. Do
not use `127.0.0.1`, an address beginning with `169.254`, or an address from a
VPN or virtual adapter. The phones must be able to reach this address.

### 3. Create the HTTPS certificate

Install mkcert, then create a local CA and a certificate containing the new
computer's LAN address. Replace the example address below:

```powershell
mkcert -install
$lanIp = "192.168.1.50"
New-Item -ItemType Directory -Path certs -Force | Out-Null
mkcert -cert-file certs/camera-windows.pem `
  -key-file certs/camera-windows-key.pem `
  $lanIp localhost 127.0.0.1 ::1
```

Export the public root CA for installation on the phones:

```powershell
$caRoot = mkcert -CAROOT
Copy-Item "$caRoot/rootCA.pem" certs/internetcafe-windows-rootCA.pem -Force
certutil -decode certs/internetcafe-windows-rootCA.pem `
  certs/internetcafe-windows-rootCA-DER.cer
```

Never share `camera-windows-key.pem`. Certificate files, private keys, and
`.env` are ignored by Git.

### 4. Configure the server

```powershell
Copy-Item .env.example .env
```

Open `.env` and replace the example address with the LAN address from step 2.
Use the Windows certificate filenames created above:

```dotenv
HOST=0.0.0.0
PORT=8443
PHONE_BASE_URL=https://192.168.1.50:8443
TLS_CERT_FILE=./certs/camera-windows.pem
TLS_KEY_FILE=./certs/camera-windows-key.pem

LOCAL_HTTP_ENABLED=true
LOCAL_HTTP_HOST=127.0.0.1
LOCAL_HTTP_PORT=8080

# Set this to the same non-empty value on the commenter station.
RELAY_SHARED_TOKEN=replace-with-an-installation-secret
```

`PHONE_BASE_URL` must contain exactly the same IP address that was included in
the certificate.

### 5. Allow phone connections through Windows Firewall

Open PowerShell as Administrator and run:

```powershell
$ruleName = "Internetcafe Influencer HTTPS 8443"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8443 `
    -Profile Private,Public `
    -RemoteAddress LocalSubnet
}
```

### 6. Start and verify the server

```powershell
pnpm test
pnpm start
```

Keep that PowerShell window open. In a second window, verify the local bridge:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/healthz
```

Then open `https://<LAN_IP>:8443/healthz` on a phone connected to the same
network. It should return JSON with `"status":"running"`.

### 7. Trust the new computer's CA on every phone

Transfer only `certs/internetcafe-windows-rootCA-DER.cer` to each phone and
install it as a trusted root CA. On iPhone, installing the profile is not
enough: also enable it under **Settings > General > About > Certificate Trust
Settings**, then fully restart Safari. Never continue through a certificate
warning; it means the CA is not trusted or the address does not match.

For additional platform notes and the TouchDesigner acceptance test, see
[WINDOWS_SETUP.md](WINDOWS_SETUP.md) and [HTTPS_SETUP.md](HTTPS_SETUP.md).

## Generate the QR code for a new computer or IP address

The QR code is generated dynamically; there is no QR image file to rebuild.
Its destination comes from `PHONE_BASE_URL` in `.env`.

1. Find the new computer's LAN IPv4 address with `ipconfig`.
2. Generate a new server certificate containing that address, following step
   3 above.
3. Put the same address in `PHONE_BASE_URL` in `.env`.
4. Restart the Node server.
5. Open `http://127.0.0.1:8080/qr/?seat=1` on the computer. The displayed QR
   code will now point to the new HTTPS address.

Use `seat=1` through `seat=7` to generate a separate connection QR for each
seat. The short seat-1 alias is `http://127.0.0.1:8080/qrcode`.

If this is a completely new computer, its mkcert installation creates a new
root CA, so the phones must trust the newly exported CA. If only the IP address
changed on the same computer, regenerate the server certificate and update
`.env`; the already trusted root CA remains the same.

## Routes

- `/qr/?seat=1` - scannable phone connection page
- `/qrcode` - short alias for the seat 1 QR page
- `/phone/?seat=1` - phone camera sender and processed-frame viewer
- `/decoder/?seat=1` - canvas captured by TouchDesigner Web Render TOP
- `http://127.0.0.1:8080/control/` - computer-only notification controls
- `/healthz` - connection, routing, and frame counters
- `/stream` - binary WebSocket endpoint
- `/comments/relay` - commenter-station WebSocket receiver

The first JSON message on every `/stream` WebSocket registers one role and seat.
Binary frames then route `phone -> decoder`, `touch-output -> phone`, and
`tracking-source -> tracking-sink`. The decoder runs browser MediaPipe in a
worker and sends versioned Float32 packets containing 478 face landmarks and
52 named blendshape scores to TouchDesigner.

## Experimental WebRTC phone transport

The JPEG transport remains the default. For a same-LAN WebRTC test, opt both
ends into the alternate transport for the same seat:

```text
http://127.0.0.1:8080/decoder/?seat=1&transport=webrtc
https://<LAN_IP>:8443/phone/?seat=1&transport=webrtc
```

In this mode the phone sends its camera track directly to the decoder page.
The decoder page performs the 720x1280 crop/scale for the existing Web Render
TOP and continues to run MediaPipe tracking. TouchDesigner's existing
`touch-output` JPEG sender is unchanged: return JPEGs are routed to the decoder
page, painted to a canvas, captured at up to 24 fps, and returned to the phone as a
WebRTC video track. The phone WebSocket remains connected for signaling,
comments, filter controls, and diagnostics.

The first implementation deliberately configures no public STUN or TURN
servers and is intended for peers on the same local network. `/healthz`
includes bounded per-seat `webrtcStats` after media negotiation starts. Remove
`transport=webrtc` from both URLs to fall back to the original JPEG path.

## Live comments and filter controls

The separate commenter server connects directly to:

```dotenv
INFLUENCER_WS_URL=wss://<INFLUENCER-IP>:8443/comments/relay
COMMENTER_STATION_ID=commenter-1
RELAY_SHARED_TOKEN=replace-with-the-same-installation-secret
```

`RELAY_SHARED_TOKEN` is optional. Leave it blank on both servers to disable
the check, or set the same non-empty value on both. Do not put the token in a
phone URL or client-side page.

The commenter sends this hello as its first text frame. `token` is omitted
when no shared token is configured:

```json
{
  "protocol": "internetcafe.comments",
  "version": 1,
  "type": "hello",
  "role": "comment-relay",
  "stationId": "commenter-1",
  "token": "optional-shared-secret"
}
```

It then sends the version-1 canonical `comment` envelopes documented in the
commenter repository. The influencer validates them and broadcasts a compact
phone message over each phone's existing `/stream` connection:

```json
{
  "type": "live-comment",
  "id": "comment-123",
  "sender": "Guest10280",
  "message": "that filter is wild",
  "receivedAt": 1785840000123
}
```

Comments are ephemeral: neither server nor phone keeps a durable history. The
server retains only the latest six accepted comments in memory for two minutes
so a newly connected or reloaded phone can rebuild the current feed. Comments
received while a seat's Live UI is disabled are not replayed after it is
re-enabled. `COMMENT_REPLAY_LIMIT` and `COMMENT_REPLAY_MAX_AGE_MS` override the
defaults. The receiver does not send an application-level acknowledgement;
the commenter continues to treat a successful WebSocket send as acceptance.
`/healthz` reports relay status under `commentRelay` and accepted, rejected,
and immediate phone-delivery counters under `comments`.

The influencer certificate is locally signed, so the commenter computer must
also trust the mkcert root CA. Copy only the influencer installation's public
`rootCA.pem` to the commenter computer. One reliable Node.js launch method is:

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\path\to\influencer-rootCA.pem"
pnpm start
```

```sh
NODE_EXTRA_CA_CERTS=/path/to/influencer-rootCA.pem pnpm start
```

Set this before starting Node; changing it inside a running process has no
effect. Never copy the CA private key or HTTPS server private key. The
certificate must include the exact IP used by `INFLUENCER_WS_URL`.

Phones are lightweight displays and control surfaces. Visitors initiate filter
changes on the phone, TouchDesigner applies them to the seat's Switch TOP, and
the influencer server owns seat routing and the latest state snapshot:

```text
phone -- {"type":"filter-step","delta":-1|1} --> server --> same-seat ws_tracking
phone <-- {"type":"filter-state","index":2,"count":5,"name":"Liquid Face"} -- ws_tracking
phone <-- {"type":"live-ui-state","enabled":true} ----------------------------- TD
```

`filter-step` is limited to one accepted request per seat every 150 ms. The
server caches `filter-state` and `live-ui-state` per seat and sends the latest
values after that seat's phone reconnects. Disabling Live UI clears the
phone's visible comment feed; comments received while it is disabled are not
queued. Filter arrows remain available because Live UI is not a master switch
for all phone controls. Both arrow buttons call `requestFilterStep(delta)`, so
a later swipe gesture can use the same protocol.

## TouchDesigner

See the [TouchDesigner file index](touchdesigner/README.md). Build the original
[standalone network](touchdesigner/docs/v1-standalone.md), or use the reusable
[`PhoneSender` Base](touchdesigner/docs/v2-phone-sender.md). The original
standalone callbacks and the Base-specific callbacks are kept as separate
files.

For face tracking without SpoutCam, follow
[`browser-face-tracking.md`](touchdesigner/docs/browser-face-tracking.md). It
recreates the artist's 479-sample compatibility `x/y` CHOP strip for the existing GLSL filter.

## Test

```sh
pnpm test
```

See [TESTING.md](TESTING.md) for the desktop socket smoke test and the physical
phone/TouchDesigner acceptance sequence.

## Scope

The notification controls and TouchDesigner SeatInput support seats 1 through
7. The WebSocket router isolates connections by seat and does not impose a
four-seat cap. WebRTC, audio, authentication, rotating grants,
StreamDiffusion, and light-ring control remain outside this milestone.
