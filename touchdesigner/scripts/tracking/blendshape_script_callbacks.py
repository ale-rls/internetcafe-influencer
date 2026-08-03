"""Script CHOP callbacks exposing MediaPipe's 52 named face blendshapes.

Attach this DAT as the Callbacks DAT of the artist's ``blendshapes`` Script
CHOP. The sibling ``ws_tracking`` DAT stores scores decoded from the browser's
binary tracking packet. Every channel has one sample and remains present with a
zero value when no face is detected, preserving a stable downstream contract.
"""


BLENDSHAPE_NAMES = (
	'_neutral',
	'browDownLeft',
	'browDownRight',
	'browInnerUp',
	'browOuterUpLeft',
	'browOuterUpRight',
	'cheekPuff',
	'cheekSquintLeft',
	'cheekSquintRight',
	'eyeBlinkLeft',
	'eyeBlinkRight',
	'eyeLookDownLeft',
	'eyeLookDownRight',
	'eyeLookInLeft',
	'eyeLookInRight',
	'eyeLookOutLeft',
	'eyeLookOutRight',
	'eyeLookUpLeft',
	'eyeLookUpRight',
	'eyeSquintLeft',
	'eyeSquintRight',
	'eyeWideLeft',
	'eyeWideRight',
	'jawForward',
	'jawLeft',
	'jawOpen',
	'jawRight',
	'mouthClose',
	'mouthDimpleLeft',
	'mouthDimpleRight',
	'mouthFrownLeft',
	'mouthFrownRight',
	'mouthFunnel',
	'mouthLeft',
	'mouthLowerDownLeft',
	'mouthLowerDownRight',
	'mouthPressLeft',
	'mouthPressRight',
	'mouthPucker',
	'mouthRight',
	'mouthRollLower',
	'mouthRollUpper',
	'mouthShrugLower',
	'mouthShrugUpper',
	'mouthSmileLeft',
	'mouthSmileRight',
	'mouthStretchLeft',
	'mouthStretchRight',
	'mouthUpperUpLeft',
	'mouthUpperUpRight',
	'noseSneerLeft',
	'noseSneerRight',
)
TRACKING_WEBSOCKET_NAME = 'ws_tracking'


def _blendshapes_enabled(scriptOp):
	"""Honor the artist patch's optional Blendshapes toggle when present."""
	owner = scriptOp.parent()
	for component in (owner, owner.parent()):
		if component is not None and hasattr(component.par, 'Blendshapes'):
			return bool(component.par.Blendshapes.eval())
	return True


def onCook(scriptOp):
	scriptOp.clear()
	scriptOp.numSamples = 1

	tracking_dat = scriptOp.parent().op(TRACKING_WEBSOCKET_NAME)
	valid = (
		_blendshapes_enabled(scriptOp)
		and tracking_dat is not None
		and tracking_dat.fetch('tracking_blendshapes_valid', False)
	)
	scores = tracking_dat.fetch('tracking_blendshapes', ()) if valid else ()

	for index, name in enumerate(BLENDSHAPE_NAMES):
		channel = scriptOp.appendChan(name)
		channel[0] = float(scores[index]) if index < len(scores) else 0.0
	return


def onPulse(par):
	return


def onSetupParameters(scriptOp):
	return
