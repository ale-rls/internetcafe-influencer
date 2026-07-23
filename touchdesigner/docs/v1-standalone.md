# TouchDesigner setup: original commissioning network

This file preserves the original standalone timer-driven version. The reusable
Base COMP version is documented separately in
[v2-phone-sender.md](v2-phone-sender.md).

Keep the original decoder and processing operators at the same network level:

```text
web_render1 -> decoded_in -> artistic filters -> processed_out
```

`web_render1` loads:

```text
http://127.0.0.1:8080/decoder/?seat=1
```

## Original standalone sender

The original callbacks remain unchanged:

| Name | Type | Purpose |
| --- | --- | --- |
| `processed_out` | Null TOP | Final TOP to send. |
| `ws_output` | WebSocket DAT | Uses `../scripts/v1/websocket_callbacks.py`. |
| `send_timer` | Timer CHOP | Repeating 0.1-second timer. |
| `send_execute` | CHOP Execute DAT | Uses `../scripts/v1/output_sender_callbacks.py`. |
| `td_status` | Text DAT | Current state. |
| `td_errors` | Text DAT | Last error. |

Configure `send_execute` to watch `send_timer` and enable Off to On. The original
files use `touch_output_connected`, `processed_out`, `td_status`, and
`td_errors`; the Base-specific files use separate names and do not alter this
contract.
