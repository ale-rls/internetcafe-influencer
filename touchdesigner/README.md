# TouchDesigner files

```text
docs/
  browser-face-tracking.md
  v1-standalone.md
  v2-phone-sender.md
toes/
  influencer_v1.toe
  influencer_v2.toe
scripts/
  tracking/
    blendshape_script_callbacks.py
    tracking_receiver_callbacks.py
    tracking_script_callbacks.py
  v1/
    output_sender_callbacks.py
    websocket_callbacks.py
  v2/
    PhoneSenderExt.py
    output_sender_callbacks.py
    param_exec_callbacks.py
    websocket_callbacks.py
```

Version 1 is the original standalone timer-driven commissioning network.
Version 2 is the reusable `PhoneSender` Base COMP. Each scripts folder is
self-contained so changes to one version do not alter the other.

Browser MediaPipe tracking is documented in
[`docs/browser-face-tracking.md`](docs/browser-face-tracking.md). It preserves
the artist's two-channel landmark strip, adds 52 named blendshape channels,
and removes the SpoutCam bridge.
