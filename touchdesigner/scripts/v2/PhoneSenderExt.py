"""Minimal TouchDesigner extension for the phone_sender Base COMP.

Required child operators:
  - stream_source       In TOP receiving the processed image
  - ws_output           WebSocket DAT
  - websocket_callbacks Text DAT used by ws_output
  - send_execute        Execute DAT that sends JPEG frames
  - param_exec          Parameter Execute DAT
"""

import json


PARAM_DEFAULTS = {
	'Seat': 1,
	'Host': '127.0.0.1',
	'Port': 8080,
	'Jpegquality': 0.7,
	'Outputfps': 24.0,
	'Benchmarksamples': 30,
	'Active': False,
	'Liveui': True,
}

LEGACY_FILTER_PARAMETERS = ('Filterindex', 'Filtercount', 'Filtername')


class ParameterManager:
	def __init__(self, owner_comp):
		self.ownerComp = owner_comp

	def _get_page(self, name):
		for page in self.ownerComp.customPages:
			if page.name == name:
				return page
		return None

	def setup(self):
		page = self._get_page('Phone Sender')
		if not page:
			page = self.ownerComp.appendCustomPage('Phone Sender')

		par = self.ownerComp.par

		if not hasattr(par, 'Seat'):
			p = page.appendInt('Seat', label='Seat')[0]
			p.default = p.val = PARAM_DEFAULTS['Seat']
			p.min = 1
			p.clampMin = True

		if not hasattr(par, 'Host'):
			p = page.appendStr('Host', label='Host')[0]
			p.default = p.val = PARAM_DEFAULTS['Host']

		if not hasattr(par, 'Port'):
			p = page.appendInt('Port', label='Port')[0]
			p.default = p.val = PARAM_DEFAULTS['Port']
			p.min, p.max = 1, 65535
			p.clampMin = p.clampMax = True

		if not hasattr(par, 'Jpegquality'):
			p = page.appendFloat('Jpegquality', label='JPEG Quality')[0]
			p.default = p.val = PARAM_DEFAULTS['Jpegquality']
			p.min, p.max = 0.1, 1.0
			p.clampMin = p.clampMax = True

		if not hasattr(par, 'Outputfps'):
			p = page.appendFloat('Outputfps', label='Output FPS')[0]
			p.default = p.val = PARAM_DEFAULTS['Outputfps']
			p.min, p.max = 1.0, PARAM_DEFAULTS['Outputfps']
			p.clampMin = p.clampMax = True
		else:
			p = par.Outputfps
			# Migrate components that still carry the previous 10 fps default.
			if abs(float(p.eval()) - 10.0) < 0.001:
				p.val = PARAM_DEFAULTS['Outputfps']
			p.default = PARAM_DEFAULTS['Outputfps']
			p.min, p.max = 1.0, PARAM_DEFAULTS['Outputfps']
			p.clampMin = p.clampMax = True

		if not hasattr(par, 'Benchmarksamples'):
			p = page.appendInt('Benchmarksamples', label='Benchmark Samples')[0]
			p.default = p.val = PARAM_DEFAULTS['Benchmarksamples']
			p.min, p.max = 5, 120
			p.clampMin = p.clampMax = True

		if not hasattr(par, 'Benchmarksender'):
			page.appendPulse('Benchmarksender', label='Benchmark Sender')

		if not hasattr(par, 'Active'):
			p = page.appendToggle('Active', label='Active')[0]
			p.default = p.val = PARAM_DEFAULTS['Active']

		if not hasattr(par, 'Liveui'):
			p = page.appendToggle('Liveui', label='Live UI')[0]
			p.default = p.val = PARAM_DEFAULTS['Liveui']

		# Remove parameters created by the first filter-control implementation.
		# Filter state now comes directly from the authoritative Switch TOP.
		for name in LEGACY_FILTER_PARAMETERS:
			legacy_par = getattr(par, name, None)
			if legacy_par is not None:
				try:
					legacy_par.destroy()
				except Exception:
					pass

	def setup_param_exec(self):
		param_exec = self.ownerComp.op('param_exec')
		if param_exec is None:
			return

		param_exec.par.op = self.ownerComp.path
		param_exec.par.pars = 'Active Seat Host Port Liveui Benchmarksender'
		param_exec.par.valuechange = True
		param_exec.par.custom = True
		param_exec.par.builtin = False


class PhoneSenderExt:
	def __init__(self, ownerComp):
		self.ownerComp = ownerComp
		self.params = ParameterManager(ownerComp)
		self.state = 'IDLE'
		self.params.setup()
		self.params.setup_param_exec()

		# Preserve the saved Active state across project loads and extension
		# re-initialization. Forcing this off here leaves copied senders looking
		# configured while their WebSocket and Execute DAT are both stopped.
		if self.ownerComp.par.Active.eval():
			self.Start()
		else:
			self.Stop()

		print('PhoneSenderExt initialized')

	def Start(self):
		stream_source = self.ownerComp.op('stream_source')
		if stream_source is None or stream_source.width == 0 or stream_source.height == 0:
			print('PhoneSender Error: no TOP connected to stream_source')
			self.state = 'ERROR'
			self.ownerComp.par.Active.val = False
			return

		ws_output = self.ownerComp.op('ws_output')
		send_execute = self.ownerComp.op('send_execute')
		missing = []
		if ws_output is None:
			missing.append('ws_output')
		if send_execute is None:
			missing.append('send_execute')
		if missing:
			print('PhoneSender Error: missing {}'.format(', '.join(missing)))
			self.state = 'ERROR'
			self.ownerComp.par.Active.val = False
			return

		ws_output.par.active = False
		ws_output.store('touch_output_registered', False)
		ws_output.par.netaddress = self.ownerComp.par.Host.eval()
		ws_output.par.port = int(self.ownerComp.par.Port.eval())
		ws_output.par.callbacks = self.ownerComp.op('websocket_callbacks')
		ws_output.par.active = True
		send_execute.par.framestart = True
		send_execute.par.active = True

		self.state = 'STREAMING'
		print('PhoneSender: streaming seat {}'.format(int(self.ownerComp.par.Seat.eval())))

	def Stop(self):
		send_execute = self.ownerComp.op('send_execute')
		if send_execute is not None:
			send_execute.par.active = False

		ws_output = self.ownerComp.op('ws_output')
		if ws_output is not None:
			ws_output.par.active = False
			ws_output.store('touch_output_registered', False)

		self.state = 'IDLE'

	def _registeredWebSocket(self):
		ws_output = self.ownerComp.op('ws_output')
		if ws_output is None:
			return None
		if not ws_output.fetch('touch_output_registered', False, search=False):
			return None
		return ws_output

	def _sendControlMessage(self, payload):
		ws_output = self._registeredWebSocket()
		if ws_output is None:
			return False

		bytes_sent = ws_output.sendText(json.dumps(payload))
		if bytes_sent is not None and bytes_sent < 0:
			ws_output.store('touch_output_registered', False)
			self.ownerComp.store('phone_sender_status', 'control message send failed ({})'.format(bytes_sent))
			return False
		return True

	def SendLiveUiState(self):
		return self._sendControlMessage({
			'type': 'live-ui-state',
			'enabled': bool(self.ownerComp.par.Liveui.eval()),
		})

	def SendControlState(self):
		"""Publish PhoneSender-owned state after WebSocket registration."""
		self.SendLiveUiState()

	def StartSenderBenchmark(self):
		send_execute = self.ownerComp.op('send_execute')
		if send_execute is None:
			return
		send_execute.store('sender_benchmark_active', True)
		send_execute.store('sender_benchmark_phase', 0)
		send_execute.store('sender_benchmark_warmup', 2)
		send_execute.store('sender_benchmark_collected', 0)
		send_execute.store('sender_benchmark_delayed_none', 0)
		send_execute.store('sender_benchmark_samples', {})
		send_execute.store('sender_benchmark_target', int(self.ownerComp.par.Benchmarksamples.eval()))
		self.ownerComp.store('sender_benchmark_results', {})
		self.ownerComp.store('sender_benchmark_error', '')
		print('PhoneSender: sender benchmark started; normal output is temporarily paused')

	def OnParameterChange(self, par):
		if par.name == 'Active':
			if par.eval():
				self.Start()
			else:
				self.Stop()
		elif par.name in ('Seat', 'Host', 'Port') and self.state == 'STREAMING':
			self.Stop()
			self.Start()
		elif par.name == 'Liveui':
			self.SendLiveUiState()
		elif par.name == 'Benchmarksender':
			self.StartSenderBenchmark()
