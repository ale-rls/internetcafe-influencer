"""Script CHOP callbacks that expose browser landmarks as x/y channels.

The output deliberately matches the artist's existing two-channel contract:
478 MediaPipe landmarks plus one compatibility sample in ``x`` and ``y``.
Feed it through the same Null CHOP and CHOP to TOP used by the GLSL effect.
MediaPipe y coordinates are top-down, so y is flipped into TouchDesigner's
bottom-up UV convention here.
"""

import numpy as np


# MediaPipe supplies landmarks 0..477. The artist's GLSL samples an N x 1
# landmark TOP using a hardcoded texture width of 479, so keep one trailing
# compatibility sample to preserve that existing shader contract.
MEDIAPIPE_LANDMARK_COUNT = 478
OUTPUT_SAMPLE_COUNT = 479
TRACKING_WEBSOCKET_NAME = 'ws_tracking'
FLIP_X = False
FLIP_Y = True
_OUTPUT = np.zeros((2, OUTPUT_SAMPLE_COUNT), dtype=np.float32)


def _ensure_layout(scriptOp):
	channels = scriptOp.chans()
	if len(channels) != 2 or channels[0].name != 'x' or channels[1].name != 'y':
		scriptOp.clear()
		scriptOp.appendChan('x')
		scriptOp.appendChan('y')
	if scriptOp.numSamples != OUTPUT_SAMPLE_COUNT:
		scriptOp.numSamples = OUTPUT_SAMPLE_COUNT


def onCook(scriptOp):
	_ensure_layout(scriptOp)
	# The old clear/append path implicitly zeroed invalid tracking frames. Keep
	# that contract explicitly so the last valid face never freezes on screen.
	_OUTPUT.fill(0.0)

	tracking_dat = scriptOp.parent().op(TRACKING_WEBSOCKET_NAME)
	if tracking_dat is not None and tracking_dat.fetch('tracking_valid', False):
		# ``asarray`` is zero-copy for the receiver's ndarray and also tolerates
		# tuple storage left in an older saved .toe during callback replacement.
		landmarks = np.asarray(tracking_dat.fetch('tracking_landmarks', ()), dtype=np.float32)
		count = (
			min(len(landmarks), MEDIAPIPE_LANDMARK_COUNT)
			if landmarks.ndim == 2 and landmarks.shape[1] >= 2
			else 0
		)
		if count:
			x = landmarks[:count, 0]
			y = landmarks[:count, 1]
			if FLIP_X:
				np.subtract(1.0, x, out=_OUTPUT[0, :count])
			else:
				_OUTPUT[0, :count] = x
			if FLIP_Y:
				np.subtract(1.0, y, out=_OUTPUT[1, :count])
			else:
				_OUTPUT[1, :count] = y

	scriptOp.copyNumpyArray(_OUTPUT)
	return
