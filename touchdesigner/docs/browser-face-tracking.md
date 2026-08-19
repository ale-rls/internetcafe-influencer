# Browser MediaPipe face tracking

The decoder page runs MediaPipe on the exact 720x1280 phone frame displayed by
the Web Render TOP. A second WebSocket carries full-precision landmark and
blendshape values to TouchDesigner. This replaces the MediaPipe TOX, Spout Out
TOP, and SpoutCam.

```text
phone -> decoder canvas -> Web Render TOP -----------------------> GLSL input 0
                    \-> MediaPipe worker -> tracking WebSocket
                                             |-> landmark Script CHOP
                                             |   -> CHOP to TOP --> GLSL input 1
                                             \-> blendshape Script CHOP
```

The browser sends a fixed, versioned binary format. Version 2 face frames
contain a 28-byte header followed by 478 `x,y,z` Float32 triples and 52
canonical Float32 blendshape scores. No-face frames contain only the header,
which clears stale landmarks and scores in TouchDesigner. The TouchDesigner
receiver still accepts the older version 1 landmark-only packets.

## Windows performance baseline

Before profiling Python or JPEG output, enable **Use Shared Texture** on every
Web Render TOP. This keeps the CEF-to-TouchDesigner handoff on a shared Direct3D
texture instead of copying through shared CPU memory. All
`TouchDesignerWebRender.exe` processes and TouchDesigner itself must be assigned
to the same NVIDIA GPU in Windows **System > Display > Graphics**. If a Web
Render TOP stops producing an image, attach an Info DAT, inspect its error, and
turn Shared Texture back off for that operator.

Confirm that every decoder selected MediaPipe's GPU delegate. The decoder body
exposes `data-tracking-delegate="GPU"` after its tracking worker starts. Treat a
`CPU` value as a configuration or per-process GPU problem before changing the
tracking architecture.

Record the TouchDesigner frame-time baseline after both checks. Use that same
configuration for all later 12/15/24 fps sender comparisons.

## TouchDesigner operators

Create these operators beside the artist's existing face-tracking network:

| Name | Type | Configuration |
| --- | --- | --- |
| `ws_tracking` | WebSocket DAT | Address `127.0.0.1`, port `8080`, callbacks `tracking_receiver_callbacks`. |
| `tracking_receiver_callbacks` | Text DAT | Paste `../scripts/tracking/tracking_receiver_callbacks.py`. |
| `tracking_landmarks` | Script CHOP | Callbacks DAT `tracking_script_callbacks`. |
| `tracking_script_callbacks` | Text DAT | Paste `../scripts/tracking/tracking_script_callbacks.py`. |
| `blendshapes` | Script CHOP | Callbacks DAT `blendshape_script_callbacks`; 52 named channels with one sample each. |
| `blendshape_script_callbacks` | Text DAT | Paste `../scripts/tracking/blendshape_script_callbacks.py`. |
| `tracking_status` | Text DAT | Optional visible connection status. |
| `tracking_errors` | Text DAT | Optional visible packet/WebSocket errors. |

Set `ws_tracking` Active on. Its callback registers as `tracking-sink` for seat
1. To use another seat, run this once in the textport before activating it:

```python
op('ws_tracking').parent().store('tracking_seat', 2)
```

### Phone filter controls

The same `ws_tracking` connection also receives the phone's tiny text control
messages alongside binary tracking packets. The server routes a same-seat
arrow press as:

```json
{"type":"filter-step","delta":1}
```

By default, `tracking_receiver_callbacks` controls `switch2` inside the sibling
Base named `filter` (`../filter/switch2` from `SeatInput`). Connect the available
filter TOPs to that switch in phone navigation order. If it has another name or
location, store a relative path on `SeatInput` once:

```python
op('/project1/SeatInput').store('filter_switch_path', '../filter/switch2')
```

The callback accepts only `-1` or `1`, wraps the Switch TOP's `Index`, infers
the count from connected inputs, and returns the selected input name to the
phone through the same WebSocket:

```json
{"type":"filter-state","index":2,"count":5,"name":"Liquid Face"}
```

No additional WebSocket DAT is required. If the switch cannot be resolved,
`tracking_errors` and the `tracking_error` storage entry report the problem.

Set the Web Render TOP and the downstream image-processing TOP chain to
`720x1280`. Do not stretch a square intermediate into the portrait output; the
browser landmarks are normalized against this exact portrait frame. The phone
requests a wider 4:3 camera stream with browser cropping disabled, then performs
one centered cover crop into the 9:16 canvas. This avoids device-specific
double cropping while producing full-bleed portrait video without stretching.

The browser packet contains 478 MediaPipe landmarks. The compatibility Script
CHOP outputs 479 samples in two channels named `x` and `y`: samples 0-477 hold
the landmarks and the final sample is zero padding because the artist's GLSL
hardcodes a 479-pixel landmark texture. Connect it to the artist's existing
Null CHOP and CHOP to TOP. Keep the CHOP to TOP's existing resolution, channel
mapping, and floating-point pixel format so the GLSL shader receives the same
strip layout as before.

The callback converts MediaPipe's top-down y coordinate to TouchDesigner's
bottom-up UV convention. If the image is mirrored elsewhere in the network,
set `FLIP_X = True` near the top of `tracking_script_callbacks.py`.

### Connect the artist's blendshape patch

The artist patch shown with an `in1` JSON DAT, a `blendshapes` Script CHOP, and
a downstream `rename1` CHOP can keep the `blendshapes` and `rename1` operators.
Replace the old JSON-parsing callbacks with
`blendshape_script_callbacks.py`, and set the `blendshapes` Script CHOP's
Callbacks DAT to that Text DAT. The new callback reads the already decoded
scores from the sibling `ws_tracking` DAT, so `in1` and `json.loads` are no
longer required. The callbacks use the NumPy package bundled with
TouchDesigner.

The Script CHOP always creates the canonical 52 MediaPipe channels in the same
order as the artist's `BlendShapes` table, from `_neutral` through
`noseSneerRight`. Each channel contains one sample. When no face is present—or
when the artist component's optional `Blendshapes` parameter is off—all
channels remain present with value `0`. The existing `rename1` CHOP may remain
connected if downstream channel renaming is still needed.

Landmark and blendshape CHOP cooks are deferred until the end of the current
TouchDesigner frame. This avoids a circular cook dependency between
`ws_tracking` and the Script CHOPs while retaining event-driven updates.
The receiver copies each validated packet payload into owned float32 arrays
before that deferred cook. Both Script CHOPs retain their channel layout, clear
their reusable output arrays on every cook, and use one whole-CHOP NumPy copy.
No-face packets therefore clear the output instead of freezing the last face.

## Alignment and diagnostics

- `/healthz` should show both `tracking-source` and `tracking-sink` as `true`
  for the seat.
- `ws_tracking.fetch('tracking_valid', False)` indicates whether the latest
  packet contains a face.
- `ws_tracking.fetch('tracking_frame_id', 0)` exposes the browser frame ID.
- `ws_tracking.fetch('tracking_landmark_count', 0)` should be 478 with a face.
- `ws_tracking.fetch('tracking_blendshapes_valid', False)` indicates whether
  the latest packet contains the complete blendshape set.
- `ws_tracking.fetch('tracking_blendshape_count', 0)` should be 52 with a face.
- The decoder stores the selected MediaPipe delegate on its body as
  `data-tracking-delegate="GPU"` or `"CPU"`.

MediaPipe completes after the corresponding decoder frame is painted. If a
filter visibly trails the face, delay the Web Render TOP by the measured number
of frames with a Cache TOP; do not queue tracking packets.
