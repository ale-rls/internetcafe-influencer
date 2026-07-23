# TouchDesigner files

```text
docs/
  v1-standalone.md
  v2-phone-sender.md
toes/
  influencer_v1.toe
  influencer_v2.toe
scripts/
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
