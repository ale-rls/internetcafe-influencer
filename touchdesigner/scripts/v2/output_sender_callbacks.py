# Paste this file directly into PhoneSender/send_execute (an Execute DAT).
# Enable only Frame Start. JPEG quality and output rate come from PhoneSender.

import time


DEFAULT_OUTPUT_FPS = 10.0


def _should_throttle(now, last_send, send_interval_seconds):
	if last_send is None:
		return False

	elapsed = now - last_send
	# Operator storage is saved in the .toe, while time.monotonic() resets
	# when the machine restarts. A negative elapsed time is a saved timestamp
	# from the previous monotonic clock and must not suppress new output.
	return 0 <= elapsed < send_interval_seconds


def _send_interval_seconds():
	output_fps_par = getattr(me.parent().par, 'Outputfps', None)
	output_fps = float(output_fps_par.eval()) if output_fps_par is not None else DEFAULT_OUTPUT_FPS
	output_fps = max(1.0, min(30.0, output_fps))
	return 1.0 / output_fps


def _error_once(message):
	if me.fetch('last_error', None, search=False) == message:
		return
	me.store('last_error', message)
	debug('[phone_sender] ERROR: ' + message)


def _send_processed_jpeg():
	ws_output = me.parent().op('ws_output')
	if ws_output is None:
		_error_once('Missing required WebSocket DAT: ws_output')
		raise RuntimeError('Missing ws_output')

	if not ws_output.fetch('touch_output_registered', False, search=False):
		return

	stream_source = me.parent().op('stream_source')
	if stream_source is None:
		_error_once('Missing required TOP: stream_source')
		raise RuntimeError('Missing stream_source')

	quality_par = getattr(me.parent().par, 'Jpegquality', None)
	quality = float(quality_par.eval()) if quality_par is not None else 0.7
	quality = max(0.1, min(1.0, quality))
	jpeg = stream_source.saveByteArray('.jpg', quality=quality)
	bytes_sent = ws_output.sendBinary(jpeg)
	if bytes_sent is not None and bytes_sent < 0:
		ws_output.store('touch_output_registered', False)
		_error_once('JPEG send failed ({})'.format(bytes_sent))
		return

	me.store('last_error', None)
	me.parent().store('last_jpeg_bytes', bytes_sent if bytes_sent is not None else len(jpeg))
	me.parent().store('last_jpeg_quality', quality)


def onStart():
	return


def onCreate():
	return


def onExit():
	return


def onFrameStart(frame):
	if not bool(me.parent().par.Active):
		return

	now = time.monotonic()
	last_send = me.fetch('last_send_monotonic', None, search=False)
	if _should_throttle(now, last_send, _send_interval_seconds()):
		return

	me.store('last_send_monotonic', now)
	_send_processed_jpeg()
	return


def onFrameEnd(frame):
	return


def onPlayStateChange(state):
	return


def onDeviceChange():
	return
