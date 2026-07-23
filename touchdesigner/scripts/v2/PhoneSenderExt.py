"""Minimal TouchDesigner extension for the phone_sender Base COMP.

Required child operators:
  - stream_source       In TOP receiving the processed image
  - ws_output           WebSocket DAT
  - websocket_callbacks Text DAT used by ws_output
  - send_execute        Execute DAT that sends JPEG frames
  - param_exec          Parameter Execute DAT
"""


PARAM_DEFAULTS = {
	'Seat': 1,
	'Host': '127.0.0.1',
	'Port': 8080,
	'Active': False,
}


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

		if not hasattr(par, 'Active'):
			p = page.appendToggle('Active', label='Active')[0]
			p.default = p.val = PARAM_DEFAULTS['Active']

	def setup_param_exec(self):
		param_exec = self.ownerComp.op('param_exec')
		if param_exec is None:
			return

		param_exec.par.op = self.ownerComp.path
		param_exec.par.pars = 'Active Seat Host Port'
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

		# Always load stopped, matching the StreamDiffusion component.
		self.ownerComp.par.Active.val = False
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

	def OnParameterChange(self, par):
		if par.name == 'Active':
			if par.eval():
				self.Start()
			else:
				self.Stop()
		elif par.name in ('Seat', 'Host', 'Port') and self.state == 'STREAMING':
			self.Stop()
			self.Start()
