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
JPEG Quality, Output FPS, Active, and Live UI. Each sender defaults to JPEG
quality `0.7` at a maximum of 24 fps. Existing components still carrying the
old 10 fps default are migrated to 24 fps when the extension is re-initialized.
For multi-phone projects, lower JPEG quality or Output FPS if TouchDesigner
cannot sustain all seats at the 24 fps cap.

## Live UI

`Liveui` controls the phone's Instagram-style comment overlay and decorative
chrome. It does not disable the previous/next filter controls. Changing the
toggle publishes the current state over `ws_output`:

```json
{"type":"live-ui-state","enabled":true}
```

After each successful WebSocket registration, the component republishes the
current Live UI state so the influencer server can refresh the snapshot it
sends when a phone reconnects. Phone filter requests enter TouchDesigner over
the existing `SeatInput/ws_tracking` connection instead; see
[`browser-face-tracking.md`](browser-face-tracking.md#phone-filter-controls).
