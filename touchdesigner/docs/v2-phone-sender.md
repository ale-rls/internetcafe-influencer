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
extension after all exact-name children exist. It creates two custom parameter
pages:

- **Control**: Active, Seat, Live UI, FPS Overlay, and Phone Controls
- **Settings**: Host, Port, JPEG Quality, Output FPS, Benchmark Samples, and
  Benchmark Sender

Existing parameters are moved between pages without being recreated, so their
saved values and parameter modes remain intact. Each sender defaults to JPEG
quality `0.7` at a maximum of 24 fps. Existing components still carrying the
old 10 fps default are migrated to 24 fps when the extension is re-initialized.

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

During a live seven-seat run, inspect the rolling synchronous readback cost and
confirm the production rate directly:

```python
s = op('/project1/PhoneSender')
print('save average ms:', s.fetch('sender_average_save_ms', None, search=False))
print('output fps:', s.par.Outputfps.eval())
```

`saveByteArray()` performs a GPU-to-CPU readback and JPEG encode on
TouchDesigner's main thread. If `sender_average_save_ms` is more than a few
milliseconds per active seat, seven senders can consume a substantial part of
the cook budget. First lower **JPEG Quality** below `0.7`, then reduce the TOP
resolution upstream of `stream_source` if the artwork allows it. Confirm every
production component is actually set to **Output FPS = 24** before interpreting
return-FPS or latency measurements; reduce it deliberately only after measuring
the full installation.

TouchDesigner's Video Stream Out TOP could eventually send hardware-encoded
WebRTC and remove the JPEG encode, WebSocket, browser bitmap decode, canvas,
and re-encode bridge. Treat that as a future/endgame architecture change, not
part of this latency milestone: the current JPEG bridge remains easier to
inspect and recover while the installation is being stabilized.

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

## FPS overlay

`Showfps` controls the complete FPS status card on the phone, including its
title, seat, connection status, and uplink/downlink values. Changing the toggle
publishes the current state over `ws_output`:

```json
{"type":"fps-overlay-state","enabled":true}
```

The component republishes this state after WebSocket registration, and the
server caches it per seat so reconnecting phones receive the latest setting.

## Phone controls

`Phonecontrols` controls the visitor-facing input elements on the phone: the
normalized slider and both previous/next filter buttons. It does not hide the
Live comment overlay or FPS status card. Changing the toggle publishes:

```json
{"type":"phone-controls-state","enabled":true}
```

The component republishes this state after WebSocket registration, and the
server caches it per seat so reconnecting phones restore the latest setting.
