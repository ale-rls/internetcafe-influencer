"""Script CHOP callbacks that expose browser landmarks as x/y channels.

The output deliberately matches the artist's existing two-channel contract:
478 MediaPipe landmarks plus one compatibility sample in ``x`` and ``y``.
Feed it through the same Null CHOP and CHOP to TOP used by the GLSL effect.
MediaPipe y coordinates are top-down, so y is flipped into TouchDesigner's
bottom-up UV convention here.
"""


# MediaPipe supplies landmarks 0..477. The artist's GLSL samples an N x 1
# landmark TOP using a hardcoded texture width of 479, so keep one trailing
# compatibility sample to preserve that existing shader contract.
MEDIAPIPE_LANDMARK_COUNT = 478
OUTPUT_SAMPLE_COUNT = 479
TRACKING_WEBSOCKET_NAME = 'ws_tracking'
FLIP_X = False
FLIP_Y = True


def onCook(scriptOp):
	scriptOp.clear()
	scriptOp.appendChan('x')
	scriptOp.appendChan('y')
	scriptOp.numSamples = OUTPUT_SAMPLE_COUNT

	tracking_dat = scriptOp.parent().op(TRACKING_WEBSOCKET_NAME)
	if tracking_dat is None or not tracking_dat.fetch('tracking_valid', False):
		return

	landmarks = tracking_dat.fetch('tracking_landmarks', ())
	for index, landmark in enumerate(landmarks[:MEDIAPIPE_LANDMARK_COUNT]):
		x = float(landmark[0])
		y = float(landmark[1])
		scriptOp['x'][index] = 1.0 - x if FLIP_X else x
		scriptOp['y'][index] = 1.0 - y if FLIP_Y else y
	return
