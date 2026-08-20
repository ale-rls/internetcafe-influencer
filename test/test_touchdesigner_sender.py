"""Pure-Python checks for the TouchDesigner sender's frame scheduler."""

import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CALLBACKS = ROOT / 'touchdesigner' / 'scripts' / 'v2' / 'output_sender_callbacks.py'
SPEC = importlib.util.spec_from_file_location('output_sender_callbacks', CALLBACKS)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FrameSchedulerTests(unittest.TestCase):
	class FakeParameter:
		def __init__(self, value):
			self.value = value

		def eval(self):
			return self.value

	class FakeMe:
		def __init__(self, seat=1):
			self.values = {}
			self.owner = type('Owner', (), {})()
			self.owner.par = type('Parameters', (), {})()
			self.owner.par.Seat = FrameSchedulerTests.FakeParameter(seat)

		def parent(self):
			return self.owner

		def fetch(self, key, default, search=False):
			return self.values.get(key, default)

		def store(self, key, value):
			self.values[key] = value

	def should_send_at(self, timestamps, seat=1):
		fake_me = self.FakeMe(seat)
		original_me = getattr(MODULE, 'me', None)
		original_perf_counter = MODULE.time.perf_counter
		clock = iter(timestamps)
		MODULE.me = fake_me
		MODULE.time.perf_counter = lambda: next(clock)
		try:
			return [MODULE._should_send(None) for _ in timestamps]
		finally:
			MODULE.time.perf_counter = original_perf_counter
			if original_me is None:
				del MODULE.me
			else:
				MODULE.me = original_me

	def scheduled_counts(self, output_fps):
		previous_slots = {
			seat: MODULE._send_slot(0, output_fps, seat)
			for seat in range(1, 8)
		}
		counts = []
		for frame in range(1, 61):
			due = 0
			for seat in range(1, 8):
				current_slot = MODULE._send_slot(frame / 60, output_fps, seat)
				if current_slot != previous_slots[seat]:
					due += 1
				previous_slots[seat] = current_slot
			counts.append(due)
		return counts

	def test_each_seat_hits_requested_rate(self):
		for output_fps in (12, 15, 24):
			with self.subTest(output_fps=output_fps):
				for seat in range(1, 8):
					previous_slot = MODULE._send_slot(0, output_fps, seat)
					count = 0
					for frame in range(1, 61):
						current_slot = MODULE._send_slot(frame / 60, output_fps, seat)
						if current_slot != previous_slot:
							count += 1
						previous_slot = current_slot
					self.assertEqual(count, output_fps)

	def test_twenty_four_fps_reaches_two_or_three_sends_per_frame(self):
		counts = self.scheduled_counts(24)
		self.assertEqual(set(counts), {2, 3})
		self.assertEqual(sum(counts), 7 * 24)

	def test_twelve_fps_reaches_one_or_two_sends_per_frame(self):
		counts = self.scheduled_counts(12)
		self.assertEqual(set(counts), {1, 2})
		self.assertEqual(sum(counts), 7 * 12)

	def test_rate_is_clamped_to_output_limit(self):
		self.assertEqual(MODULE._send_slot(1, 120, 1), 24)

	def test_repeated_callbacks_inside_one_slot_send_only_once(self):
		self.assertEqual(self.should_send_at((0.042, 0.044, 0.060)), [True, False, False])

	def test_skipped_slot_sends_once_without_catch_up_burst(self):
		self.assertEqual(self.should_send_at((0.001, 0.090, 0.091)), [True, True, False])

	def test_two_millisecond_cook_jitter_visits_each_output_slot_once(self):
		timestamps = [
			(frame / 60) + (0.002 if frame % 2 else -0.002)
			for frame in range(1, 601)
		]
		acted_slots = []
		previous_slot = None
		for timestamp in timestamps:
			current_slot = MODULE._send_slot(timestamp, 24, 1)
			if current_slot != previous_slot:
				acted_slots.append(current_slot)
				previous_slot = current_slot
		self.assertEqual(
			acted_slots,
			list(range(acted_slots[0], acted_slots[-1] + 1)),
		)


if __name__ == '__main__':
	unittest.main()
