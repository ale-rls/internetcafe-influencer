# Paste this file directly into PhoneSender/send_execute (an Execute DAT).
# Enable only Frame Start. JPEG quality and output rate come from PhoneSender.

import math
import statistics
import time


DEFAULT_OUTPUT_FPS = 24.0
DEFAULT_COOK_FPS = 60.0
DEFAULT_SEAT_COUNT = 7
BENCHMARK_PHASES = (
	'saveByteArray',
	'numpyArrayImmediate',
	'numpyArrayDelayed',
	'convertUint8Bgr',
	'cv2Imencode',
)
BENCHMARK_WARMUP_FRAMES = 2
TIMING_ALPHA = 0.1


def _output_fps():
	output_fps_par = getattr(me.parent().par, 'Outputfps', None)
	output_fps = float(output_fps_par.eval()) if output_fps_par is not None else DEFAULT_OUTPUT_FPS
	return max(1.0, min(DEFAULT_OUTPUT_FPS, output_fps))


def _cook_fps():
	try:
		return max(1.0, float(project.cookRate))
	except Exception:
		return DEFAULT_COOK_FPS


def _absolute_frame(callback_frame):
	try:
		return int(absTime.frame)
	except Exception:
		return int(callback_frame)


def _frame_is_due(frame, output_fps, cook_fps, seat, seat_count=DEFAULT_SEAT_COUNT):
	"""Distribute fractional-rate seat sends across absolute cook frames."""
	cook_fps = max(1.0, float(cook_fps))
	output_fps = max(0.0, min(float(output_fps), cook_fps))
	seat_count = max(1, int(seat_count))
	seat_index = (max(1, int(seat)) - 1) % seat_count
	phase = seat_index * cook_fps / seat_count
	current_slot = math.floor((int(frame) * output_fps + phase) / cook_fps)
	previous_slot = math.floor(((int(frame) - 1) * output_fps + phase) / cook_fps)
	return current_slot != previous_slot


def _should_send(frame):
	seat_par = getattr(me.parent().par, 'Seat', None)
	seat = int(seat_par.eval()) if seat_par is not None else 1
	return _frame_is_due(_absolute_frame(frame), _output_fps(), _cook_fps(), seat)


def _error_once(message):
	if me.fetch('last_error', None, search=False) == message:
		return
	me.store('last_error', message)
	debug('[phone_sender] ERROR: ' + message)


def _record_timing(name, elapsed_ms):
	owner = me.parent()
	last_key = 'sender_last_{}_ms'.format(name)
	average_key = 'sender_average_{}_ms'.format(name)
	maximum_key = 'sender_maximum_{}_ms'.format(name)
	previous_average = owner.fetch(average_key, None, search=False)
	average = elapsed_ms if previous_average is None else (
		TIMING_ALPHA * elapsed_ms + (1.0 - TIMING_ALPHA) * float(previous_average)
	)
	owner.store(last_key, elapsed_ms)
	owner.store(average_key, average)
	owner.store(maximum_key, max(elapsed_ms, float(owner.fetch(maximum_key, 0.0, search=False))))


def _send_processed_jpeg():
	total_started = time.perf_counter()
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
	started = time.perf_counter()
	jpeg = stream_source.saveByteArray('.jpg', quality=quality)
	_record_timing('save', (time.perf_counter() - started) * 1000.0)
	started = time.perf_counter()
	bytes_sent = ws_output.sendBinary(jpeg)
	_record_timing('send', (time.perf_counter() - started) * 1000.0)
	_record_timing('total', (time.perf_counter() - total_started) * 1000.0)
	if bytes_sent is not None and bytes_sent < 0:
		ws_output.store('touch_output_registered', False)
		_error_once('JPEG send failed ({})'.format(bytes_sent))
		return

	me.store('last_error', None)
	me.parent().store('last_jpeg_bytes', bytes_sent if bytes_sent is not None else len(jpeg))
	me.parent().store('last_jpeg_quality', quality)


def _percentile_95(values):
	if not values:
		return None
	ordered = sorted(values)
	return ordered[int(math.ceil(len(ordered) * 0.95)) - 1]


def _finish_benchmark():
	samples = me.fetch('sender_benchmark_samples', {}, search=False)
	results = {}
	for phase in BENCHMARK_PHASES:
		phase_samples = list(samples.get(phase, ()))
		results[phase] = {
			'samples': len(phase_samples),
			'averageMs': statistics.fmean(phase_samples) if phase_samples else None,
			'p95Ms': _percentile_95(phase_samples),
			'maximumMs': max(phase_samples) if phase_samples else None,
		}
	stream_source = me.parent().op('stream_source')
	results['source'] = {
		'width': stream_source.width if stream_source is not None else 0,
		'height': stream_source.height if stream_source is not None else 0,
		'pixelFormat': getattr(stream_source, 'pixelFormatName', '') if stream_source is not None else '',
	}
	results['delayedNoneCount'] = int(me.fetch('sender_benchmark_delayed_none', 0, search=False))
	me.parent().store('sender_benchmark_results', results)
	me.store('sender_benchmark_active', False)
	debug('[phone_sender] sender benchmark complete: {}'.format(results))


def _advance_benchmark_phase(phase_index):
	next_index = phase_index + 1
	if next_index >= len(BENCHMARK_PHASES):
		_finish_benchmark()
		return
	me.store('sender_benchmark_phase', next_index)
	me.store('sender_benchmark_warmup', BENCHMARK_WARMUP_FRAMES)
	me.store('sender_benchmark_collected', 0)


def _convert_for_opencv(source_array):
	import cv2
	import numpy as np

	converted = np.clip(source_array * 255.0, 0.0, 255.0).astype(np.uint8)
	converted = np.flipud(converted)
	if converted.ndim == 3 and converted.shape[2] == 4:
		return cv2.cvtColor(converted, cv2.COLOR_RGBA2BGR)
	if converted.ndim == 3 and converted.shape[2] == 3:
		return cv2.cvtColor(converted, cv2.COLOR_RGB2BGR)
	return converted


def _run_benchmark_operation(stream_source, phase, quality):
	if phase == 'saveByteArray':
		started = time.perf_counter()
		stream_source.saveByteArray('.jpg', quality=max(0.1, min(1.0, quality)))
		return (time.perf_counter() - started) * 1000.0, True
	if phase == 'numpyArrayImmediate':
		started = time.perf_counter()
		result = stream_source.numpyArray(delayed=False)
		return (time.perf_counter() - started) * 1000.0, result is not None
	if phase == 'numpyArrayDelayed':
		started = time.perf_counter()
		result = stream_source.numpyArray(delayed=True)
		return (time.perf_counter() - started) * 1000.0, result is not None

	# Conversion and encoding are measured separately from their required
	# synchronous diagnostic readback. They predict the worker-side cost only.
	source_array = stream_source.numpyArray(delayed=False)
	if source_array is None:
		return 0.0, False
	if phase == 'convertUint8Bgr':
		started = time.perf_counter()
		_convert_for_opencv(source_array)
		return (time.perf_counter() - started) * 1000.0, True

	import cv2
	converted = _convert_for_opencv(source_array)
	started = time.perf_counter()
	success, _jpeg = cv2.imencode(
		'.jpg',
		converted,
		[int(cv2.IMWRITE_JPEG_QUALITY), int(round(max(0.1, min(1.0, quality)) * 100.0))],
	)
	return (time.perf_counter() - started) * 1000.0, bool(success)


def _run_benchmark_step():
	"""Run one user-requested readback diagnostic sample, suppressing output."""
	if not me.fetch('sender_benchmark_active', False, search=False):
		return False

	stream_source = me.parent().op('stream_source')
	if stream_source is None:
		me.store('sender_benchmark_active', False)
		_error_once('Sender benchmark needs stream_source')
		return True

	phase_index = int(me.fetch('sender_benchmark_phase', 0, search=False))
	phase = BENCHMARK_PHASES[phase_index]
	warmup = int(me.fetch('sender_benchmark_warmup', BENCHMARK_WARMUP_FRAMES, search=False))
	quality_par = getattr(me.parent().par, 'Jpegquality', None)
	quality = float(quality_par.eval()) if quality_par is not None else 0.7
	try:
		elapsed_ms, result_available = _run_benchmark_operation(stream_source, phase, quality)
	except Exception as error:
		me.parent().store('sender_benchmark_error', '{}: {}'.format(phase, error))
		me.store('sender_benchmark_active', False)
		_error_once('Sender benchmark failed during {}: {}'.format(phase, error))
		return True

	if warmup > 0:
		me.store('sender_benchmark_warmup', warmup - 1)
		return True

	if phase == 'numpyArrayDelayed' and not result_available:
		me.store(
			'sender_benchmark_delayed_none',
			int(me.fetch('sender_benchmark_delayed_none', 0, search=False)) + 1,
		)

	samples = dict(me.fetch('sender_benchmark_samples', {}, search=False))
	phase_samples = list(samples.get(phase, ()))
	if result_available:
		phase_samples.append(elapsed_ms)
	samples[phase] = phase_samples
	me.store('sender_benchmark_samples', samples)
	collected = int(me.fetch('sender_benchmark_collected', 0, search=False)) + 1
	me.store('sender_benchmark_collected', collected)
	target = int(me.fetch('sender_benchmark_target', 30, search=False))
	if collected >= target:
		_advance_benchmark_phase(phase_index)
	return True


def onStart():
	return


def onCreate():
	return


def onExit():
	return


def onFrameStart(frame):
	if not bool(me.parent().par.Active):
		return

	if _run_benchmark_step():
		return

	if not _should_send(frame):
		return

	_send_processed_jpeg()
	return


def onFrameEnd(frame):
	return


def onPlayStateChange(state):
	return


def onDeviceChange():
	return
