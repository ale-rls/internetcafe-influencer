# Windows setup and seat 1 test

This guide configures the terminal server on Windows for one phone and
TouchDesigner seat 1. The phone uses trusted HTTPS/WSS on the LAN, while
TouchDesigner uses plaintext HTTP/WS restricted to the same computer.

## 1. Requirements

- Windows 10 or 11
- Node.js 22 or newer
- pnpm 9.12.2 (the version declared in `package.json`)
- A phone and this computer on the same LAN
- TouchDesigner for the full round-trip test

Open PowerShell in the repository and verify the tools:

```powershell
node --version
corepack --version
```

If Node.js is not installed, install a current Node.js release from
[nodejs.org](https://nodejs.org/). If `corepack` is missing after installing
Node.js, install it with npm:

```powershell
npm install --global corepack
```

Activate the repository's pnpm version and install the locked dependencies:

```powershell
corepack enable
corepack prepare pnpm@9.12.2 --activate
pnpm install --frozen-lockfile
```

## 2. Find the LAN IPv4 address

Run:

```powershell
ipconfig
```

Use the `IPv4 Address` from the active Ethernet or Wi-Fi adapter. Do not use a
virtual adapter, `127.0.0.1`, or an address beginning with `169.254`.

The setup performed on 23 July 2026 used the wired Ethernet address
`192.168.178.121`. Because the address is assigned by DHCP, it can change after
changing networks or restarting the router. The automatic startup configuration
below detects that change and refreshes the certificate.

## 3. Install mkcert and create the certificate

Install [mkcert](https://github.com/FiloSottile/mkcert) using its official
Windows instructions or a pre-built Windows binary. Then create and install a
local development CA:

```powershell
mkcert -install
```

Set the address found in the previous step and generate the server certificate:

```powershell
$lanIp = "192.168.178.121"
New-Item -ItemType Directory -Path certs -Force | Out-Null
mkcert -cert-file certs/camera-windows.pem `
  -key-file certs/camera-windows-key.pem `
  $lanIp localhost 127.0.0.1 ::1
```

Export the root CA for the test phone. The second command converts the PEM CA
to DER, which iPhone recognizes reliably:

```powershell
$caRoot = mkcert -CAROOT
Copy-Item "$caRoot/rootCA.pem" certs/internetcafe-windows-rootCA.pem -Force
certutil -decode certs/internetcafe-windows-rootCA.pem `
  certs/internetcafe-windows-rootCA-DER.cer
```

Certificate and key files are ignored by Git. Never send
`camera-windows-key.pem` to a phone or commit it.

## 4. Configure `.env`

Create `.env` from `.env.example` if it does not exist:

```powershell
Copy-Item .env.example .env
```

Set the LAN address and Windows certificate paths:

```dotenv
HOST=0.0.0.0
PORT=8443
PHONE_BASE_URL=https://192.168.178.121:8443
TLS_CERT_FILE=./certs/camera-windows.pem
TLS_KEY_FILE=./certs/camera-windows-key.pem
AUTO_LAN_IP=true
```

With `AUTO_LAN_IP=true`, startup replaces only the hostname in
`PHONE_BASE_URL` in memory and refreshes the mkcert certificate if the detected
address is not already covered. It does not rewrite `.env`. If both Ethernet
and Wi-Fi are active and the wrong one is selected, add
`LAN_IP=192.168.178.121` with the address reachable by the phones.

With TLS configured, the server also starts the loopback-only TouchDesigner
bridge at `http://127.0.0.1:8080` and `ws://127.0.0.1:8080`. Port 8080 is not
exposed to the LAN.

## 5. Allow HTTPS through Windows Firewall

Open PowerShell as Administrator and add a rule limited to the local subnet:

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

Confirm the rule:

```powershell
Get-NetFirewallRule -DisplayName "Internetcafe Influencer HTTPS 8443"
```

## 6. Start and stop the server

For normal operation, keep this PowerShell window open:

```powershell
pnpm start
```

Expected startup messages:

```text
[startup] using LAN IPv4 192.168.178.121 from Ethernet
Internetcafe Influencer listening on https://localhost:8443
TouchDesigner bridge listening on http://127.0.0.1:8080
Phone URL base: https://192.168.178.121:8443
```

When the address changes, a preceding `[startup] refreshing HTTPS certificate`
message is also expected. `mkcert` must remain installed and available on
`PATH` for that refresh.

Verify the local health endpoint in another PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/healthz
```

Stop a foreground server with `Ctrl+C`. The server does not automatically
restart after a Windows reboot.

To start it in a hidden background process instead:

```powershell
$projectDir = (Get-Location).Path
$nodeExe = (Get-Command node).Source
$server = Start-Process `
  -FilePath $nodeExe `
  -ArgumentList "--env-file-if-exists=.env", "server/index.js" `
  -WorkingDirectory $projectDir `
  -WindowStyle Hidden `
  -PassThru
$server.Id
```

Record the printed process ID. Stop that process later with:

```powershell
Stop-Process -Id <PROCESS_ID>
```

### Run the server as a supervised service

For an exhibition, use either NSSM or Task Scheduler instead of the hidden
one-off process above. Do not configure both methods for the same checkout.

With [NSSM](https://nssm.cc/) installed, run an elevated PowerShell and replace
the project path below. Point NSSM directly at Node so it can supervise the
actual long-running process:

```powershell
$projectDir = "C:\installations\internetcafe-influencer"
$nodeExe = (Get-Command node).Source
nssm install InternetCafeInfluencer $nodeExe "--env-file-if-exists=.env server/index.js"
nssm set InternetCafeInfluencer AppDirectory $projectDir
nssm set InternetCafeInfluencer AppExit Default Restart
nssm set InternetCafeInfluencer AppRestartDelay 3000
nssm set InternetCafeInfluencer Start SERVICE_AUTO_START
nssm start InternetCafeInfluencer
```

Verify it with `Get-Service InternetCafeInfluencer` and
`Invoke-RestMethod http://127.0.0.1:8080/healthz`. NSSM's `AppExit Default
Restart` setting restarts Node after an unexpected exit, and automatic start
brings it back after reboot.

Without NSSM, create a startup task in an elevated PowerShell:

```powershell
$projectDir = "C:\installations\internetcafe-influencer"
$nodeExe = (Get-Command node).Source
$action = New-ScheduledTaskAction `
  -Execute $nodeExe `
  -Argument "--env-file-if-exists=.env server/index.js" `
  -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable
Register-ScheduledTask `
  -TaskName "InternetCafeInfluencer" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User "SYSTEM" `
  -RunLevel Highest
Start-ScheduledTask -TaskName "InternetCafeInfluencer"
```

In Task Scheduler, confirm **If the task fails, restart every 1 minute** and
**Run whether user is logged on or not**. After either setup, stop the service
or task before running a second foreground server, otherwise the ports will
already be occupied.

## 7. Trust the CA on an iPhone

Transfer only `certs/internetcafe-windows-rootCA-DER.cer` to the iPhone using
an approved method.

1. Open the certificate on the iPhone.
2. Open **Settings > Profile Downloaded** and complete the installation.
3. Open **Settings > General > About > Certificate Trust Settings**.
4. Under **Enable Full Trust for Root Certificates**, enable the mkcert CA.
5. Completely close and reopen Safari.

Installing the profile alone does not enable SSL/TLS trust. Apple documents
the additional full-trust step in
[Trust manually installed certificate profiles](https://support.apple.com/en-gb/102390).

Do not bypass a privacy warning. Before scanning the QR code, open this exact
address on the phone and confirm it loads without a warning:

```text
https://192.168.178.121:8443/healthz
```

The response should report `"transport":"https/wss"`.

### Trust the CA on Android

Transfer only `certs/internetcafe-windows-rootCA-DER.cer`. On the phone, open
**Settings > Security > Install certificates > CA certificate** and select the
file. Manufacturer labels can differ; search Settings for “CA certificate” if
needed. Android warns that network traffic can be inspected by a user CA, so
use this installation-only CA and never transfer the private key. Chrome should
then open the exact `https://<LAN_IP>:8443/healthz` address without a warning.

## 8. Test seat 1

On the Windows computer, open:

```text
http://127.0.0.1:8080/qr/?seat=1
http://127.0.0.1:8080/decoder/?seat=1
```

Scan the QR code with the iPhone, tap **Start camera**, grant camera access,
and keep the page in the foreground. The decoder page should show the phone
camera.

For `influencer_v2.toe`, connect the processed TOP to `PhoneSender` and set:

- `Seat = 1`
- `Host = 127.0.0.1`
- `Port = 8080`
- `Active = On`
- `PhoneSender/send_execute`: **Active** and **Frame Start** on

The live health response should contain:

```json
"1": {
  "phone": true,
  "decoder": true,
  "touch-output": true
}
```

The received and forwarded frame counters should rise continuously with zero
persistent backpressure drops.

Keep `http://127.0.0.1:8080/control/` open as the operator view. Each seat card
shows role connectivity, return FPS, last decoded-frame age, WebRTC-stats age,
and recent average jitter-buffer delay. A red card means the phone is offline,
its statistics are stale, or decoded return frames have stopped for five
seconds. Missing browser metrics appear as “—” rather than making the seat
look failed.

Before exhibition day, leave all seven charged phones running for at least one
hour. Ensure airflow is not blocked, watch for falling FPS or stale frames, and
inspect `webrtcStats` in `/healthz` for `qualityLimitation`. A persistent `cpu`
limitation suggests encoder or thermal pressure; reduce camera resolution to
what the artwork actually needs before accepting a degraded all-day setup.

### v2 return-stream diagnostics

If the phone camera reaches TouchDesigner but the processed image does not
return to the phone, open TouchDesigner's Textport and point `s` to the
`PhoneSender` Base:

```python
s = op('/project1/PhoneSender')
```

If the component has a different path, right-click it, select **Copy OP Path**,
and use that path instead.

Check the input dimensions, WebSocket registration, Execute DAT state, and
Frame Start callback:

```python
print(
    s.op('stream_source').width,
    s.op('stream_source').height,
    s.op('ws_output').fetch('touch_output_registered', False),
    s.op('send_execute').par.active.eval(),
    s.op('send_execute').par.framestart.eval(),
)
```

A healthy 720x1280 configuration prints:

```text
720 1280 True True True
```

Send one JPEG manually to test the full TouchDesigner-to-phone path:

```python
jpeg = s.op('stream_source').saveByteArray('.jpg', quality=0.7)
print(len(jpeg), s.op('ws_output').sendBinary(jpeg))
```

The byte length should be greater than zero and one frame should immediately
appear on the phone. If that works but automatic sending remains idle, confirm
the installed callback contains the absolute-frame scheduler:

```python
print('onFrameStart' in s.op('send_execute').text)
print('_frame_is_due' in s.op('send_execute').text)
print(s.par.Outputfps.eval(), project.cookRate, absTime.frame)
```

The current callback does not store a monotonic throttle timestamp in the
`.toe`; it derives every decision directly from the absolute frame, target
output rate, project cook rate, and seat number. Re-paste
`touchdesigner/scripts/v2/output_sender_callbacks.py` if `_frame_is_due` is
missing.

For performance commissioning, enable **Use Shared Texture** on all Web Render
TOPs and assign TouchDesigner plus every `TouchDesignerWebRender.exe` process
to the same NVIDIA GPU. Then compare all seven seats at Output FPS 12, 15, and
24. The tracking delegate must remain GPU at every seat.

The PhoneSender extension also provides **Benchmark Sender**. Leave the sender
Active, pulse it once, wait for the completion message, then inspect:

```python
print(s.fetch('sender_benchmark_results', {}, search=False))
print(s.fetch('sender_benchmark_error', '', search=False))
```

Normal return frames pause while this explicit benchmark compares synchronous
JPEG, immediate and delayed raw readback, pixel conversion, and OpenCV JPEG
encoding. Do not pulse all seven benchmarks simultaneously.

## Troubleshooting

- Phone cannot reach port 8443: confirm both devices are on the same normal
  LAN, not a guest Wi-Fi, and confirm the firewall rule is enabled.
- iPhone reports a privacy warning: confirm the certificate contains the
  current LAN IP and enable full trust for the installed root CA.
- Phone reaches TouchDesigner but receives no return image: inspect `/healthz`.
  All three roles must be true, and the total frame rate should include both
  phone and TouchDesigner streams.
- TouchDesigner cannot connect: use `127.0.0.1:8080`, not the LAN IP, for its
  decoder and WebSocket connections.
