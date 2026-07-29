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
`192.168.178.121`. Because the address is assigned by DHCP, check it again
after changing networks or restarting the router. If it changes, update
`.env` and regenerate the server certificate.

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
```

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
Internetcafe Influencer listening on https://localhost:8443
TouchDesigner bridge listening on http://127.0.0.1:8080
Phone URL base: https://192.168.178.121:8443
```

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
appear on the phone. If that works but automatic sending remains idle, inspect
the sender callback and its stored throttle timestamp:

```python
print('onFrameStart' in s.op('send_execute').text)
print(s.op('send_execute').fetch('last_send_monotonic', None, search=False))
```

The `.toe` may contain a stale monotonic timestamp saved on another runtime.
This can make the 10 fps throttle suppress every automatic send. Clear it:

```python
s.op('send_execute').store('last_send_monotonic', None)
```

This is the command that restored automatic return streaming during the Windows
seat 1 commissioning test. It is a runtime workaround and does not edit project
source. Automatic return frames should begin immediately.

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
