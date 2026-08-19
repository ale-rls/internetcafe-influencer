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
	def scheduled_seats(self, frame, output_fps, cook_fps=60):
		return [
			seat
			for seat in range(1, 8)
			if MODULE._frame_is_due(frame, output_fps, cook_fps, seat)
		]

	def test_each_seat_hits_requested_rate(self):
		for output_fps in (12, 15, 24):
			with self.subTest(output_fps=output_fps):
				for seat in range(1, 8):
					count = sum(
						MODULE._frame_is_due(frame, output_fps, 60, seat)
						for frame in range(1, 61)
					)
					self.assertEqual(count, output_fps)

	def test_twenty_four_fps_reaches_two_or_three_sends_per_frame(self):
		counts = [len(self.scheduled_seats(frame, 24)) for frame in range(1, 61)]
		self.assertEqual(set(counts), {2, 3})
		self.assertEqual(sum(counts), 7 * 24)

	def test_twelve_fps_reaches_one_or_two_sends_per_frame(self):
		counts = [len(self.scheduled_seats(frame, 12)) for frame in range(1, 61)]
		self.assertEqual(set(counts), {1, 2})
		self.assertEqual(sum(counts), 7 * 12)

	def test_rate_is_clamped_to_cook_rate(self):
		for frame in range(1, 11):
			self.assertTrue(MODULE._frame_is_due(frame, 120, 60, 1))


if __name__ == '__main__':
	unittest.main()
