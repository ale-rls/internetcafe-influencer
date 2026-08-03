# `PhoneSender` Base COMP

Keep the decoder and all artistic processing outside the custom component:

```text
web_render1 -> decoded_in -> artistic filters -> PhoneSender
```

Create these exact children inside `PhoneSender`:

| Name | Type | Paste |
| --- | --- | --- |
| `stream_source` | In TOP | Receives the Base input. |
| `ws_output` | WebSocket DAT | Uses the `websocket_callbacks` Text DAT below. |
| `websocket_callbacks` | Text DAT | `../scripts/v2/websocket_callbacks.py` |
| `send_execute` | Execute DAT | `../scripts/v2/output_sender_callbacks.py`; Frame Start on. |
| `param_exec` | Parameter Execute DAT | `../scripts/v2/param_exec_callbacks.py` |
| `PhoneSenderExt` | Text DAT | `../scripts/v2/PhoneSenderExt.py` |

Attach `PhoneSenderExt` through **Customize Component**, then re-init the
extension after all exact-name children exist. It creates Seat, Host, Port,
JPEG Quality, Output FPS, and Active. Each sender defaults to JPEG quality `0.7`
at a maximum of 10 fps. For multi-phone projects, start with quality `0.6` and
8 fps per sender, then increase them only if TouchDesigner remains responsive.
