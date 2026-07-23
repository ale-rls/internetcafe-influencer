# Paste this file directly into PhoneSender/send_execute (an Execute DAT).
# Enable only Frame Start. The 10 JPEG/second limit stays internal for now.

import time


SEND_INTERVAL_SECONDS = 0.1


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

	jpeg = stream_source.saveByteArray('.jpg', quality=0.7)
	bytes_sent = ws_output.sendBinary(jpeg)
	if bytes_sent is not None and bytes_sent < 0:
		ws_output.store('touch_output_registered', False)
		_error_once('JPEG send failed ({})'.format(bytes_sent))
		return

	me.store('last_error', None)
	me.parent().store('last_jpeg_bytes', bytes_sent if bytes_sent is not None else len(jpeg))


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
	if last_send is not None and now - last_send < SEND_INTERVAL_SECONDS:
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
