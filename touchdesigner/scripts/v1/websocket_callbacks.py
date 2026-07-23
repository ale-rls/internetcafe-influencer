# Attach this Text DAT to the Callbacks DAT parameter of ws_output (WebSocket DAT).
# Required sibling Text DATs: td_status and td_errors.

def _status(message):
	"""Write the current connection state to an always-visible Text DAT."""
	op('td_status').text = message
	debug(message)


def _error(message):
	"""Make errors visible in the network and in TouchDesigner's textport."""
	op('td_errors').text = message
	_status('ERROR: ' + message)


# me - this DAT
# dat - the WebSocket DAT that connected
def onConnect(dat):
	# Send this exact JSON handshake before allowing JPEG output.
	bytes_sent = dat.sendText('{"type":"hello","role":"touch-output","seat":1}')
	if bytes_sent < 0:
		dat.store('touch_output_connected', False)
		_error('WebSocket hello send failed ({})'.format(bytes_sent))
		raise RuntimeError('WebSocket hello send failed')

	dat.store('touch_output_connected', True)
	_status('Connected: touch-output seat 1')
	return


# me - this DAT
# dat - the WebSocket DAT that disconnected
def onDisconnect(dat):
	dat.store('touch_output_connected', False)
	_status('Disconnected: waiting for terminal server')
	return


# me - this DAT
# dat - the WebSocket DAT that received a text frame
# rowIndex - the row the message was placed into
# message - unicode text from the server
def onReceiveText(dat, rowIndex, message):
	_status('Server: ' + message)
	return


# me - this DAT
# dat - the WebSocket DAT that received a binary frame
# contents - a byte array
def onReceiveBinary(dat, contents):
	_status('Received {} binary bytes from server'.format(len(contents)))
	return


# me - this DAT
# dat - the WebSocket DAT that received a ping frame
# contents - a byte array
def onReceivePing(dat, contents):
	dat.sendPong(contents)
	return


# me - this DAT
# dat - the WebSocket DAT that received a pong frame
# contents - a byte array
def onReceivePong(dat, contents):
	return


# me - this DAT
# dat - the WebSocket DAT issuing a status/error message
# message - unicode status text
def onMonitorMessage(dat, message):
	# The WebSocket DAT also logs this in the textport; preserve it in the network.
	if 'error' in message.lower() or 'fail' in message.lower():
		dat.store('touch_output_connected', False)
		_error('WebSocket: ' + message)
	else:
		_status('WebSocket: ' + message)
	return
