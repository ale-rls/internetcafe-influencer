"""WebSocket DAT callbacks for browser MediaPipe face tracking.

Attach this DAT to a WebSocket DAT named ``ws_tracking``. The browser decoder
runs MediaPipe and sends versioned binary packets through the local server.
Decoded landmarks and blendshapes are stored on the WebSocket DAT for sibling
Script CHOPs.
"""

import json
import struct


PACKET_MAGIC = 0x4B525449  # ASCII "ITRK" in the packet's little-endian order.
LANDMARK_PACKET_VERSION = 1
BLENDSHAPE_PACKET_VERSION = 2
V1_HEADER_FORMAT = '<IHHIdHH'
V2_HEADER_FORMAT = '<IHHIdHHHH'
V1_HEADER_BYTES = struct.calcsize(V1_HEADER_FORMAT)
V2_HEADER_BYTES = struct.calcsize(V2_HEADER_FORMAT)
FACE_PRESENT_FLAG = 1
BLENDSHAPES_PRESENT_FLAG = 2
EXPECTED_VALUES_PER_LANDMARK = 3
EXPECTED_VALUES_PER_BLENDSHAPE = 1
EXPECTED_BLENDSHAPE_COUNT = 52
MAX_LANDMARKS = 1024
TRACKING_CHOP_NAMES = ('tracking_landmarks', 'blendshapes', 'tracking_blendshapes')


def _parent(dat):
	return dat.parent()


def _seat(dat):
	owner = _parent(dat)
	if hasattr(owner.par, 'Seat'):
		return int(owner.par.Seat.eval())
	return int(owner.fetch('tracking_seat', 1))


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


def _cook_tracking_chops(dat):
	for name in TRACKING_CHOP_NAMES:
		tracking_chop = _parent(dat).op(name)
		if tracking_chop is None:
			continue
		# Do not cook the Script CHOP inside the WebSocket DAT's own cook. The
		# Script CHOPs read this DAT's storage, so an immediate force-cook creates
		# a circular dependency. End-of-frame execution lets this cook finish.
		run('args[0].cook(force=True)', tracking_chop, endFrame=True)


def _clear_tracking(dat):
	dat.store('tracking_landmarks', ())
	dat.store('tracking_blendshapes', ())
	dat.store('tracking_valid', False)
	dat.store('tracking_blendshapes_valid', False)
	dat.store('tracking_landmark_count', 0)
	dat.store('tracking_blendshape_count', 0)
	_cook_tracking_chops(dat)


def onConnect(dat):
	dat.store('tracking_registered', False)
	_clear_tracking(dat)
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
	_clear_tracking(dat)
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
		if len(contents) < V1_HEADER_BYTES:
			raise ValueError('packet is shorter than the {}-byte header'.format(V1_HEADER_BYTES))

		magic, version, flags, frame_id, timestamp_ms, landmark_count, value_count = struct.unpack_from(
			V1_HEADER_FORMAT,
			contents,
			0,
		)
		if magic != PACKET_MAGIC:
			raise ValueError('packet magic does not match ITRK')

		if version == LANDMARK_PACKET_VERSION:
			header_bytes = V1_HEADER_BYTES
			blendshape_count = 0
			blendshape_value_count = EXPECTED_VALUES_PER_BLENDSHAPE
		elif version == BLENDSHAPE_PACKET_VERSION:
			if len(contents) < V2_HEADER_BYTES:
				raise ValueError('version 2 packet is shorter than the {}-byte header'.format(V2_HEADER_BYTES))
			(
				magic,
				version,
				flags,
				frame_id,
				timestamp_ms,
				landmark_count,
				value_count,
				blendshape_count,
				blendshape_value_count,
			) = struct.unpack_from(V2_HEADER_FORMAT, contents, 0)
			header_bytes = V2_HEADER_BYTES
		else:
			raise ValueError('unsupported packet version {}'.format(version))

		if value_count != EXPECTED_VALUES_PER_LANDMARK:
			raise ValueError('expected xyz values, received {}'.format(value_count))
		if blendshape_value_count != EXPECTED_VALUES_PER_BLENDSHAPE:
			raise ValueError('expected one value per blendshape, received {}'.format(blendshape_value_count))
		if landmark_count > MAX_LANDMARKS:
			raise ValueError('landmark count {} exceeds safety limit'.format(landmark_count))
		if blendshape_count > EXPECTED_BLENDSHAPE_COUNT:
			raise ValueError('blendshape count {} exceeds {}'.format(
				blendshape_count,
				EXPECTED_BLENDSHAPE_COUNT,
			))
		if flags & BLENDSHAPES_PRESENT_FLAG:
			if not flags & FACE_PRESENT_FLAG:
				raise ValueError('blendshapes cannot be present without a face')
			if blendshape_count != EXPECTED_BLENDSHAPE_COUNT:
				raise ValueError('expected {} blendshapes, received {}'.format(
					EXPECTED_BLENDSHAPE_COUNT,
					blendshape_count,
				))
		elif blendshape_count:
			raise ValueError('blendshape values are present without the blendshape flag')

		landmark_value_total = landmark_count * value_count
		blendshape_value_total = blendshape_count * blendshape_value_count
		expected_bytes = header_bytes + (landmark_value_total + blendshape_value_total) * 4
		if len(contents) != expected_bytes:
			raise ValueError('packet length is {}, expected {}'.format(len(contents), expected_bytes))

		if landmark_value_total:
			flat = struct.unpack_from('<{}f'.format(landmark_value_total), contents, header_bytes)
			landmarks = tuple(
				(flat[index], flat[index + 1], flat[index + 2])
				for index in range(0, landmark_value_total, value_count)
			)
		else:
			landmarks = ()

		if blendshape_value_total:
			blendshape_offset = header_bytes + landmark_value_total * 4
			blendshapes = struct.unpack_from(
				'<{}f'.format(blendshape_value_total),
				contents,
				blendshape_offset,
			)
		else:
			blendshapes = ()

		valid = bool(flags & FACE_PRESENT_FLAG) and bool(landmarks)
		blendshapes_valid = (
			valid
			and bool(flags & BLENDSHAPES_PRESENT_FLAG)
			and len(blendshapes) == EXPECTED_BLENDSHAPE_COUNT
		)
		dat.store('tracking_landmarks', landmarks if valid else ())
		dat.store('tracking_blendshapes', blendshapes if blendshapes_valid else ())
		dat.store('tracking_valid', valid)
		dat.store('tracking_blendshapes_valid', blendshapes_valid)
		dat.store('tracking_frame_id', frame_id)
		dat.store('tracking_timestamp_ms', timestamp_ms)
		dat.store('tracking_packet_version', version)
		dat.store('tracking_landmark_count', len(landmarks) if valid else 0)
		dat.store('tracking_blendshape_count', len(blendshapes) if blendshapes_valid else 0)
		dat.store('tracking_error', '')
		_cook_tracking_chops(dat)
	except Exception as error:
		_clear_tracking(dat)
		_error(dat, 'invalid tracking packet: {}'.format(error))
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
