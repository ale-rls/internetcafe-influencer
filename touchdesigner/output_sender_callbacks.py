# Attach this Text DAT to send_execute (a CHOP Execute DAT).
# The execute DAT watches send_timer's timer_pulse channel with Off to On enabled.
# Configure send_timer as a repeating 0.1-second Timer CHOP (10 Hz).


def _status(message):
	op('td_status').text = message
	debug(message)


def _error(message):
	op('td_errors').text = message
	_status('ERROR: ' + message)


def _send_processed_jpeg():
	ws_output = op('ws_output')
	if ws_output is None:
		_error('Missing required WebSocket DAT: ws_output')
		raise RuntimeError('Missing ws_output')

	# The connection flag is set only after the hello send succeeds in onConnect().
	if not ws_output.fetch('touch_output_connected', False, search=False):
		_status('Not connected; JPEG not sent')
		return

	processed_out = op('processed_out')
	if processed_out is None:
		_error('Missing required TOP: processed_out')
		raise RuntimeError('Missing processed_out')

	jpeg = processed_out.saveByteArray('.jpg', quality=0.7)
	bytes_sent = ws_output.sendBinary(jpeg)
	if bytes_sent < 0:
		ws_output.store('touch_output_connected', False)
		_error('JPEG send failed ({})'.format(bytes_sent))
		raise RuntimeError('JPEG send failed')

	_status('Sent JPEG: {} bytes'.format(bytes_sent))


# me - this DAT
# channel - the watched CHOP channel
# sampleIndex - sample that changed
# val - current value
# prev - previous value
def onOffToOn(channel, sampleIndex, val, prev):
	_send_processed_jpeg()
	return


def onOnToOff(channel, sampleIndex, val, prev):
	return


def whileOn(channel, sampleIndex, val, prev):
	return


def whileOff(channel, sampleIndex, val, prev):
	return


def onValueChange(channel, sampleIndex, val, prev):
	return
