# HTTPS certificate setup on macOS and Windows

The phone camera page must be served over HTTPS. The certificate must include
the terminal computer's current LAN IPv4 address, and the phone must trust the
local certificate authority (CA) that signed it.

This guide uses [mkcert](https://github.com/FiloSottile/mkcert) to create a
local CA and a server certificate. Run all commands from the repository root.

## Before you start

- Connect the terminal computer and phone to the same local network.
- Do not use `127.0.0.1`, a VPN address, a virtual-adapter address, or an
  address beginning with `169.254` as the LAN IP.
- Never copy the server private key to a phone or commit it to Git.
- Check the LAN IP again after changing networks or restarting the router. If
  it changes, startup can regenerate the certificate automatically when
  `AUTO_LAN_IP=true`.

Certificate files and `.env` are already ignored by this repository.

## macOS

### 1. Install mkcert

With Homebrew installed:

```sh
brew install mkcert
mkcert -install
```

`mkcert -install` creates a local CA and adds it to the Mac's trust store. Keep
the generated root CA private except when installing its public certificate on
the phones used by this installation.

### 2. Find the current LAN IP

Find the network interface used by the default route and read its IPv4
address:

```sh
network_interface="$(route -n get default | awk '/interface:/{print $2}')"
lan_ip="$(ipconfig getifaddr "$network_interface")"
printf '%s\n' "$lan_ip"
```

For example, the result might be `192.168.1.50`.

### 3. Generate the certificate

Use an IP-labelled filename so an older certificate is not overwritten:

```sh
mkdir -p certs
mkcert \
  -cert-file "certs/camera-$lan_ip.pem" \
  -key-file "certs/camera-$lan_ip-key.pem" \
  "$lan_ip" localhost 127.0.0.1 ::1
```

The certificate covers the LAN address used by phones as well as the local
addresses used on the terminal computer.

### 4. Configure the server

Create `.env` if it does not exist:

```sh
test -f .env || cp .env.example .env
```

Set these values in `.env`, replacing the example IP with the value printed in
step 2:

```dotenv
HOST=0.0.0.0
PORT=8443
PHONE_BASE_URL=https://192.168.1.50:8443
TLS_CERT_FILE=./certs/camera-192.168.1.50.pem
TLS_KEY_FILE=./certs/camera-192.168.1.50-key.pem
```

The IP in `PHONE_BASE_URL` must exactly match an IP in the certificate.

### 5. Export the public root CA for phones

```sh
ca_root="$(mkcert -CAROOT)"
openssl x509 \
  -in "$ca_root/rootCA.pem" \
  -outform der \
  -out certs/internetcafe-mkcert-rootCA.cer
```

Transfer only `certs/internetcafe-mkcert-rootCA.cer` to the phones. Do not
transfer `rootCA-key.pem` or any `*-key.pem` file.

## Windows

Use PowerShell for the following steps.

### 1. Install mkcert

Install mkcert using its official Windows instructions, a trusted package
manager, or the pre-built Windows binary from the mkcert releases page. Make
sure `mkcert.exe` is on `PATH`, then run:

```powershell
mkcert -version
mkcert -install
```

`mkcert -install` creates a local CA and adds it to the Windows trust store.

### 2. Find the current LAN IP

List the active IPv4 addresses:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -ne "127.0.0.1" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.InterfaceAlias -notmatch "Loopback|VPN|Virtual"
  } |
  Format-Table InterfaceAlias, IPAddress
```

Choose the address belonging to the active Ethernet or Wi-Fi adapter. Set it
for the remaining commands:

```powershell
$lanIp = "192.168.1.50"
```

### 3. Generate the certificate

```powershell
New-Item -ItemType Directory -Path certs -Force | Out-Null
mkcert `
  -cert-file "certs/camera-$lanIp.pem" `
  -key-file "certs/camera-$lanIp-key.pem" `
  $lanIp localhost 127.0.0.1 ::1
```

### 4. Configure the server

Create `.env` if it does not exist:

```powershell
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
}
```

Set the following values in `.env`, substituting the selected address:

```dotenv
HOST=0.0.0.0
PORT=8443
PHONE_BASE_URL=https://192.168.1.50:8443
TLS_CERT_FILE=./certs/camera-192.168.1.50.pem
TLS_KEY_FILE=./certs/camera-192.168.1.50-key.pem
```

### 5. Export the public root CA for phones

```powershell
$caRoot = mkcert -CAROOT
Copy-Item "$caRoot/rootCA.pem" certs/internetcafe-mkcert-rootCA.pem -Force
certutil -decode `
  certs/internetcafe-mkcert-rootCA.pem `
  certs/internetcafe-mkcert-rootCA.cer
```

Transfer only `certs/internetcafe-mkcert-rootCA.cer` to the phones.

### 6. Allow inbound HTTPS

Open PowerShell as Administrator and add a firewall rule limited to the local
subnet:

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

## Trust the CA on a phone

Install `internetcafe-mkcert-rootCA.cer` as a trusted root certificate. Exact
menus vary by phone OS and device-management policy.

On an iPhone or iPad:

1. Open the transferred certificate and install the downloaded profile.
2. Open **Settings > General > About > Certificate Trust Settings**.
3. Enable full trust for the mkcert root CA.
4. Completely close and reopen Safari.

Installing the profile without enabling full trust is not sufficient on iOS.
Never continue past a browser privacy warning.

## Start and verify

Restart the server after creating or changing a certificate:

```sh
pnpm start
```

Then verify from a phone on the same network:

1. Open `https://<LAN_IP>:8443/healthz`.
2. Confirm it loads without a certificate warning and reports
   `"transport":"https/wss"`.
3. Open `https://<LAN_IP>:8443/phone/?seat=1` and grant camera permission.
4. Confirm the phone page reaches the Live state.

If the browser shows a certificate warning, check that:

- the URL and `PHONE_BASE_URL` use the same IP;
- the certificate includes that IP;
- the phone trusts the mkcert root CA; and
- the server was restarted after `.env` or certificate changes.

To inspect the certificate addresses directly:

```sh
openssl x509 -in certs/camera-<LAN_IP>.pem -noout -dates -ext subjectAltName
```

On Windows, the same command works when OpenSSL is available. Otherwise,
double-click the certificate file and inspect **Details > Subject Alternative
Name**.
