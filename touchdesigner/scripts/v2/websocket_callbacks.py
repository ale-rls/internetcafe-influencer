# Attach this Text DAT to PhoneSender/ws_output's Callbacks DAT parameter.

import json


def _base(dat):
	return dat.parent()


def _seat(dat):
	return int(_base(dat).par.Seat.eval())


def _status(dat, message, log=False):
	_base(dat).store('phone_sender_status', message)
	if log:
		debug('[phone_sender seat {}] {}'.format(_seat(dat), message))


def _extension(dat):
	return getattr(_base(dat).ext, 'PhoneSenderExt', None)


def onConnect(dat):
	dat.store('touch_output_registered', False)
	hello = json.dumps({
		'type': 'hello',
		'role': 'touch-output',
		'seat': _seat(dat),
	})
	bytes_sent = dat.sendText(hello)
	if bytes_sent is not None and bytes_sent < 0:
		_status(dat, 'hello send failed ({})'.format(bytes_sent), log=True)
		return

	_status(dat, 'waiting for hello acknowledgement')
	return


def onDisconnect(dat):
	dat.store('touch_output_registered', False)
	_status(dat, 'disconnected', log=True)
	return


def onReceiveText(dat, rowIndex, message):
	try:
		payload = json.loads(message)
	except Exception:
		return

	if payload.get('type') == 'hello-ack':
		if payload.get('role') != 'touch-output' or str(payload.get('seat')) != str(_seat(dat)):
			_status(dat, 'invalid hello acknowledgement', log=True)
			return

		dat.store('touch_output_registered', True)
		_status(dat, 'connected', log=True)
		extension = _extension(dat)
		if extension is not None:
			extension.SendControlState()
	elif payload.get('type') == 'error':
		dat.store('touch_output_registered', False)
		_status(dat, 'server error: {}'.format(payload.get('message', message)), log=True)
	return


def onReceiveBinary(dat, contents):
	return


def onReceivePing(dat, contents):
	dat.sendPong(contents)
	return


def onReceivePong(dat, contents):
	return


def onMonitorMessage(dat, message):
	if 'error' in message.lower() or 'fail' in message.lower():
		dat.store('touch_output_registered', False)
		_status(dat, 'websocket: ' + message, log=True)
	return
