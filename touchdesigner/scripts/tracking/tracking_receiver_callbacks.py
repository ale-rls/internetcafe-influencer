"""WebSocket DAT callbacks for browser MediaPipe face landmarks.

Attach this DAT to a WebSocket DAT named ``ws_tracking``. The browser decoder
runs MediaPipe and sends versioned binary packets through the local server.
Decoded landmarks are stored on the WebSocket DAT for the sibling Script CHOP.
"""

import json
import struct


PACKET_MAGIC = 0x4B525449  # ASCII "ITRK" in the packet's little-endian order.
PACKET_VERSION = 1
PACKET_HEADER_FORMAT = '<IHHIdHH'
PACKET_HEADER_BYTES = struct.calcsize(PACKET_HEADER_FORMAT)
FACE_PRESENT_FLAG = 1
EXPECTED_VALUES_PER_LANDMARK = 3
MAX_LANDMARKS = 1024
TRACKING_CHOP_NAME = 'tracking_landmarks'


def _parent(dat):
	return dat.parent()


def _seat(dat):
	seat = _parent(dat).fetch('tracking_seat', 1)
	return int(seat)


def _text(dat, name, message):
	target = _parent(dat).op(name)
	if target is not None:
		target.text = message


def _status(dat, message, log=False):
	dat.store('tracking_status', message)
	_text(dat, 'tracking_status', message)
	if log:
		debug('[tracking seat {}] {}'.format(_seat(dat), message))


def _error(dat, message):
	dat.store('tracking_error', message)
	_text(dat, 'tracking_errors', message)
	_status(dat, 'ERROR: ' + message, log=True)


def _cook_tracking_chop(dat):
	tracking_chop = _parent(dat).op(TRACKING_CHOP_NAME)
	if tracking_chop is not None:
		# Do not cook the Script CHOP inside the WebSocket DAT's own cook. The
		# Script CHOP reads this DAT's storage, so an immediate force-cook creates
		# a circular cook dependency. End-of-frame execution keeps the update
		# event-driven while allowing the WebSocket cook to finish first.
		run('args[0].cook(force=True)', tracking_chop, endFrame=True)


def _clear_landmarks(dat):
	dat.store('tracking_landmarks', ())
	dat.store('tracking_valid', False)
	dat.store('tracking_landmark_count', 0)
	_cook_tracking_chop(dat)


def onConnect(dat):
	dat.store('tracking_registered', False)
	_clear_landmarks(dat)
	hello = json.dumps({
		'type': 'hello',
		'role': 'tracking-sink',
		'seat': _seat(dat),
	})
	bytes_sent = dat.sendText(hello)
	if bytes_sent is not None and bytes_sent < 0:
		_error(dat, 'hello send failed ({})'.format(bytes_sent))
		return
	_status(dat, 'waiting for tracking hello acknowledgement')
	return


def onDisconnect(dat):
	dat.store('tracking_registered', False)
	_clear_landmarks(dat)
	_status(dat, 'disconnected', log=True)
	return


def onReceiveText(dat, rowIndex, message):
	try:
		payload = json.loads(message)
	except Exception:
		return

	if payload.get('type') != 'hello-ack':
		return
	if payload.get('role') != 'tracking-sink' or str(payload.get('seat')) != str(_seat(dat)):
		_error(dat, 'invalid tracking hello acknowledgement')
		return

	dat.store('tracking_registered', True)
	_status(dat, 'connected: tracking-sink seat {}'.format(_seat(dat)), log=True)
	return


def onReceiveBinary(dat, contents):
	try:
		if len(contents) < PACKET_HEADER_BYTES:
			raise ValueError('packet is shorter than the {}-byte header'.format(PACKET_HEADER_BYTES))

		magic, version, flags, frame_id, timestamp_ms, landmark_count, value_count = struct.unpack_from(
			PACKET_HEADER_FORMAT,
			contents,
			0,
		)
		if magic != PACKET_MAGIC:
			raise ValueError('packet magic does not match ITRK')
		if version != PACKET_VERSION:
			raise ValueError('unsupported packet version {}'.format(version))
		if value_count != EXPECTED_VALUES_PER_LANDMARK:
			raise ValueError('expected xyz values, received {}'.format(value_count))
		if landmark_count > MAX_LANDMARKS:
			raise ValueError('landmark count {} exceeds safety limit'.format(landmark_count))

		value_total = landmark_count * value_count
		expected_bytes = PACKET_HEADER_BYTES + value_total * 4
		if len(contents) != expected_bytes:
			raise ValueError('packet length is {}, expected {}'.format(len(contents), expected_bytes))

		if value_total:
			flat = struct.unpack_from('<{}f'.format(value_total), contents, PACKET_HEADER_BYTES)
			landmarks = tuple(
				(flat[index], flat[index + 1], flat[index + 2])
				for index in range(0, value_total, value_count)
			)
		else:
			landmarks = ()

		valid = bool(flags & FACE_PRESENT_FLAG) and bool(landmarks)
		dat.store('tracking_landmarks', landmarks if valid else ())
		dat.store('tracking_valid', valid)
		dat.store('tracking_frame_id', frame_id)
		dat.store('tracking_timestamp_ms', timestamp_ms)
		dat.store('tracking_landmark_count', len(landmarks) if valid else 0)
		dat.store('tracking_error', '')
		_cook_tracking_chop(dat)
	except Exception as error:
		_clear_landmarks(dat)
		_error(dat, 'invalid landmark packet: {}'.format(error))
	return


def onReceivePing(dat, contents):
	dat.sendPong(contents)
	return


def onReceivePong(dat, contents):
	return


def onMonitorMessage(dat, message):
	if 'error' in message.lower() or 'fail' in message.lower():
		dat.store('tracking_registered', False)
		_error(dat, 'WebSocket: ' + message)
	return
