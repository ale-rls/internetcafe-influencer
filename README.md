# Internetcafe Influencer

Local seven-seat implementation of this round trip:

```text
phone camera -> terminal WebSocket server -> TouchDesigner Web Render TOP
             <- terminal WebSocket server <- processed TouchDesigner TOP
```

The terminal process owns the web app, QR page, HTTPS, connection registry,
and binary frame routing. TouchDesigner remains an image processor and a
WebSocket client. Frames are 720x1280 portrait JPEGs; the phone uplink targets 23 fps,
while the v2 TouchDesigner return sender defaults to 10 fps. Backpressured
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

The first JSON message on every WebSocket registers one role and seat. Binary
frames then route `phone -> decoder`, `touch-output -> phone`, and
`tracking-source -> tracking-sink`. The decoder runs browser MediaPipe in a
worker and sends versioned Float32 packets containing 478 face landmarks and
52 named blendshape scores to TouchDesigner.

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
