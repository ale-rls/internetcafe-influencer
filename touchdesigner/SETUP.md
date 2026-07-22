# TouchDesigner: one-seat JPEG roundtrip

This is a hand-built TouchDesigner network for **seat 1**. The artifacts here
are callback source only; they deliberately do not include a `.toe` file.

## Operator layout

Create these operators at the same network level, with these exact names:

| Name | Type | Purpose |
| --- | --- | --- |
| `web_render1` | Web Render TOP | Loads the server decoder page. |
| `decoded_in` | Null TOP | Obvious input/test point after `web_render1`. |
| `test_pattern` | Ramp TOP (or Noise TOP) | Local test image source. |
| `test_switch` | Switch TOP | Choose local test image (input 0) or the decoded render (input 1). |
| `monochrome1` | Monochrome TOP | Makes the round-trip processing unmistakable. |
| `edge1` | Edge TOP | Adds an obvious live camera effect. |
| `processed_out` | Null TOP | The final TOP that is JPEG-encoded and sent to the server. |
| `ws_output` | WebSocket DAT | Outbound TouchDesigner-to-terminal WebSocket client. |
| `websocket_callbacks` | Text DAT | Contents of `websocket_callbacks.py`; referenced by `ws_output`'s Callbacks DAT parameter. |
| `send_timer` | Timer CHOP | Repeating 0.1-second clock. |
| `send_execute` | CHOP Execute DAT | Contents of `output_sender_callbacks.py`; sends once per `timer_pulse`. |
| `td_status` | Text DAT | Viewer-visible current state. |
| `td_errors` | Text DAT | Viewer-visible most recent error. |

Wire the TOP test chain as:

```text
web_render1 -> decoded_in -> test_switch (input 1)
test_pattern ----------------> test_switch (input 0)
test_switch -> monochrome1 -> edge1 -> processed_out
```

Set `test_switch` to input 0 first. Its changing Ramp/Noise image verifies that
the 10 Hz outbound path works before the decoder page is involved. Switch to
input 1 to send the phone camera through the Monochrome and Edge effects before
returning it to the phone. Keep the viewer flag on `processed_out` while
commissioning so the exact encoded source is obvious.

## Web Render TOP

On `web_render1`, set Source to **URL** and use the terminal server address:

```text
http://TERMINAL_HOST:PORT/decoder/?seat=1
```

Use `https://` if the terminal server is TLS-enabled. The query parameter is
required: it pairs the page with seat 1.

## WebSocket DAT

On `ws_output`, set Network Address and Network Port to the same terminal
server. For TLS, use a `wss://` Network Address when required by the server.
Turn **Active** on and set **Callbacks DAT** to `websocket_callbacks`.

`websocket_callbacks.py` sends the following exact text frame from
`onConnect(dat)`:

```json
{"type":"hello","role":"touch-output","seat":1}
```

It marks the connection usable only after that `sendText()` call succeeds.
`td_status` and `td_errors` show connection/server/send state in the network,
and each status is also written with `debug()` to TouchDesigner's textport.

## 10 Hz JPEG sender

Configure `send_timer` as a 0.1-second Timer CHOP with **Cycle** enabled and no
cycle limit. On its Outputs page, enable **Timer Pulse**, which creates the
`timer_pulse` channel at the end of every cycle. Start it, and confirm that
channel pulses once per 0.1-second cycle. Configure `send_execute` as follows:

- CHOP: `send_timer`
- Channel: `timer_pulse`
- Active: on
- Off to On: on
- All other execute toggles: off

Paste `output_sender_callbacks.py` into `send_execute`. On each `timer_pulse`
rising edge it calls exactly:

```python
op('processed_out').saveByteArray('.jpg', quality=0.7)
```

and sends the returned bytes with `ws_output.sendBinary(...)`. It does not send
while disconnected; missing operators, JPEG encoding failures, and negative
WebSocket send results are written to `td_errors`, written to the textport, and
raised so no error is silently swallowed.

## Commissioning checklist

1. Start the terminal server and open `/decoder/?seat=1` in a browser to confirm
   the server page is reachable.
2. Set `processed_out` to the `test_pattern` side of `test_switch`. Start the
   timer and confirm `td_status` reports sent JPEG byte counts every 0.1 second.
3. Confirm the server sees the touch-output hello for seat 1 and receives binary
   JPEG frames.
4. Change `test_switch` to `decoded_in` and verify the rendered decoder page is
   visibly changing at `web_render1` and `processed_out`.
5. For connection failures or server rejections, inspect the visible
   `td_errors` DAT and the TouchDesigner textport; do not rely on a silent retry.
