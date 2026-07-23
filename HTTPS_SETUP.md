# Local HTTPS for phone-camera access

The phone page calls `navigator.mediaDevices.getUserMedia()`. Browsers allow
that API in a secure context: `https://` (or `http://localhost` only). **An HTTP
URL using a LAN IP address is not a secure context and will not be allowed to
access the phone camera.** Use HTTPS for a phone on the local network.

The Node server enables HTTPS/WSS when both `TLS_CERT_FILE` and
`TLS_KEY_FILE` are set. The supplied `.env.example` uses the matching names
`certs/camera-local.pem` and `certs/camera-local-key.pem`; certificate files
are ignored by Git and must not be committed.

## Create a local certificate

Install [mkcert](https://github.com/FiloSottile/mkcert) if it is not already
available, then create and populate the local development certificate
authority on the terminal machine:

```sh
mkcert -install
LAN_IP="$(ipconfig getifaddr en0)"
mkdir -p certs
mkcert -cert-file certs/camera-local.pem -key-file certs/camera-local-key.pem \
  "$LAN_IP" localhost 127.0.0.1 ::1
```

If the terminal is connected through another network interface, replace the
`ipconfig getifaddr en0` result with its actual LAN IPv4 address. Regenerate
the certificate whenever that address changes.

## Configure and run

```sh
cp .env.example .env
```

Edit `.env` so `PHONE_BASE_URL` uses the same LAN IP that was passed to
`mkcert`, for example:

```dotenv
PHONE_BASE_URL=https://192.168.1.50:8443
```

Keep `HOST=0.0.0.0`, `PORT=8443`, `TLS_CERT_FILE`, and `TLS_KEY_FILE` as
shown unless the installation needs different values. The TLS configuration
also enables a separate `http://127.0.0.1:8080` / `ws://127.0.0.1:8080`
listener for TouchDesigner. Both listeners share one connection registry and
frame router. `LOCAL_HTTP_ENABLED=false` disables it; `LOCAL_HTTP_PORT` changes
its port. `LOCAL_HTTP_HOST` is intentionally restricted to `127.0.0.1`, so
plaintext camera traffic cannot accidentally be exposed to the LAN.

`pnpm start` and `pnpm dev` load `.env` when it exists. Start the server with:

```sh
pnpm start
```

With the TLS variables present, the health endpoint reports `"transport":
"https/wss"` and the active loopback listener under `"localHttp"`.

## Trust the certificate on one test phone

The phone must trust the mkcert local CA before it will accept the HTTPS site.
On the terminal, find the CA directory with `mkcert -CAROOT`, then transfer
the `rootCA.pem` file from that directory to one test phone using an approved
local method. Install and trust that certificate as a root CA in the phone's
operating-system settings. The exact steps vary by OS and managed-device
policy; remove the profile after testing if it is no longer needed.

## Verify

1. Put the phone and terminal on the same LAN; ensure the terminal firewall
   permits inbound TCP port 8443.
2. On the phone, open `https://<LAN_IP>:8443/healthz` and confirm it loads
   without a certificate warning and reports `https/wss`.
3. Open `https://<LAN_IP>:8443/phone/?seat=1` (or scan a QR code generated
   from the same `PHONE_BASE_URL`) and approve the camera permission.
4. Confirm the page reaches the Live state and the paired decoder receives
   frames.

Do not bypass a certificate warning: a warning means the CA is not trusted or
the certificate does not include the LAN IP being used.
