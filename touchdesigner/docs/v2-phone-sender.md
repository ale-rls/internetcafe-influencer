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
JPEG Quality, Output FPS, sender-benchmark controls, Active, and Live UI. Each
sender defaults to JPEG quality `0.7` at a maximum of 24 fps. Existing
components still carrying the old 10 fps default are migrated to 24 fps when
the extension is re-initialized.

The Execute DAT schedules output from TouchDesigner's absolute frame index.
Each seat receives a different fixed-point phase, including at fractional
ratios such as 24 output fps on a 60 Hz project. With seven active seats at
that rate, the intended distribution is two or three JPEG encodes per cook
frame rather than seven synchronized encodes. Missed frames are dropped, never
sent later as a catch-up burst.

For a seven-seat installation, test Output FPS `12`, `15`, and `24` after
enabling Web Render TOP **Use Shared Texture** and confirming all decoder
tracking delegates are GPU. Twelve fps halves TouchDesigner's return-image
readbacks and encodes without changing the phone uplink or tracking cadence.
Choose the lowest rate that looks acceptable in the final face filters.

## Sender timing and benchmark

Every transmitted frame records lightweight timings on the `PhoneSender` Base:

- `sender_last_save_ms`, `sender_average_save_ms`, and `sender_maximum_save_ms`
- `sender_last_send_ms`, `sender_average_send_ms`, and `sender_maximum_send_ms`
- `sender_last_total_ms`, `sender_average_total_ms`, and `sender_maximum_total_ms`

To decompose the synchronous JPEG cost, leave the Base Active, choose
**Benchmark Samples** (30 by default), and pulse **Benchmark Sender**. Normal
return output pauses while the one-shot benchmark runs. It measures separate
blocks for:

- TouchDesigner's synchronous `saveByteArray('.jpg')`
- immediate raw `numpyArray()` readback
- one-frame-delayed raw `numpyArray()` readback
- float RGBA to flipped uint8 BGR conversion
- OpenCV JPEG encoding of the converted pixels

Results are stored as `sender_benchmark_results` on the Base, with sample
count, average, p95, and maximum milliseconds for each block. The source
resolution and pixel format are included. Read them in the Textport with:

```python
s = op('/project1/PhoneSender')
print(s.fetch('sender_benchmark_results', {}, search=False))
print(s.fetch('sender_benchmark_error', '', search=False))
```

Run the benchmark on one seat first. Build an asynchronous JPEG path only if
delayed readback is materially cheaper than synchronous `saveByteArray()` and
the measured conversion plus `cv2Imencode` cost fits the CPU budget. The
benchmark's conversion and encoding blocks require TouchDesigner's bundled
NumPy and OpenCV modules.

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
