# QR page integration

Set `PHONE_BASE_URL` to the address a phone can actually reach, for example
`https://cafe.example`. It is required for QR generation and localhost values
are rejected. A path prefix is preserved, so `https://cafe.example/demo/`
becomes `https://cafe.example/demo/phone/?seat=1`.

The HTTP entry point can serve the page without any state or authorization:

```js
import { createQrPage } from "./qr.js";

const { html } = await createQrPage({ phoneBaseUrl: config.phoneBaseUrl, seat: 1 });
response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
response.end(html);
```

Call this from the `GET /qr` route (including the default `/?seat=1` redirect)
and return an explicit configuration error if `PHONE_BASE_URL` is not set.
