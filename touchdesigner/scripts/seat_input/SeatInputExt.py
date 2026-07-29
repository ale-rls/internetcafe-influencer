"""Extension for a reusable TouchDesigner SeatInput Base COMP.

Required children inside the Base:
  - face_tracking                  Web Render TOP
  - ws_tracking                    WebSocket DAT
  - tracking_receiver_callbacks    Text DAT used by ws_tracking
  - tracking_landmarks             Script CHOP
  - tracking_script_callbacks      Text DAT used by tracking_landmarks
  - param_exec                     Parameter Execute DAT

Attach this extension in Customize Component -> Extensions with:

  op('SeatInputExt').module.SeatInputExt(me)

Use ``SeatInputExt`` as the extension name.
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
		page = self._get_page('Seat Input')
		if page is None:
			page = self.ownerComp.appendCustomPage('Seat Input')

		par = self.ownerComp.par

		if not hasattr(par, 'Seat'):
			p = page.appendInt('Seat', label='Seat')[0]
			p.default = p.val = PARAM_DEFAULTS['Seat']
			p.min = 1
			p.max = 4
			p.clampMin = True
			p.clampMax = True

		if not hasattr(par, 'Host'):
			p = page.appendStr('Host', label='Host')[0]
			p.default = p.val = PARAM_DEFAULTS['Host']

		if not hasattr(par, 'Port'):
			p = page.appendInt('Port', label='Port')[0]
			p.default = p.val = PARAM_DEFAULTS['Port']
			p.min = 1
			p.max = 65535
			p.clampMin = True
			p.clampMax = True

		if not hasattr(par, 'Active'):
			p = page.appendToggle('Active', label='Active')[0]
			p.default = p.val = PARAM_DEFAULTS['Active']

		if not hasattr(par, 'Reload'):
			page.appendPulse('Reload', label='Reload')

	def setup_param_exec(self):
		param_exec = self.ownerComp.op('param_exec')
		if param_exec is None:
			print('SeatInput Error: missing param_exec')
			return

		param_exec.par.op = self.ownerComp.path
		param_exec.par.pars = 'Active Seat Host Port Reload'
		param_exec.par.valuechange = True
		param_exec.par.custom = True
		param_exec.par.builtin = False


class SeatInputExt:
	def __init__(self, ownerComp):
		self.ownerComp = ownerComp
		self.params = ParameterManager(ownerComp)
		self.state = 'IDLE'

		self.params.setup()
		self.params.setup_param_exec()

		if self.ownerComp.par.Active.eval():
			self.Start()
		else:
			self.Stop()

		print('SeatInputExt initialized')

	def _required_ops(self):
		return {
			'face_tracking': self.ownerComp.op('face_tracking'),
			'ws_tracking': self.ownerComp.op('ws_tracking'),
			'tracking_receiver_callbacks': self.ownerComp.op('tracking_receiver_callbacks'),
		}

	def _missing_ops(self, operators):
		return [name for name, operator in operators.items() if operator is None]

	def _web_url(self):
		return 'http://{}:{}/decoder/?seat={}'.format(
			self.ownerComp.par.Host.eval(),
			int(self.ownerComp.par.Port.eval()),
			int(self.ownerComp.par.Seat.eval()),
		)

	def Start(self):
		operators = self._required_ops()
		missing = self._missing_ops(operators)
		if missing:
			print('SeatInput Error: missing {}'.format(', '.join(missing)))
			self.state = 'ERROR'
			self.ownerComp.par.Active.val = False
			return

		web_render = operators['face_tracking']
		ws_tracking = operators['ws_tracking']
		callbacks = operators['tracking_receiver_callbacks']
		seat = int(self.ownerComp.par.Seat.eval())

		web_render.par.active = False
		ws_tracking.par.active = False

		# The existing tracking callback reads this value from its parent Base.
		self.ownerComp.store('tracking_seat', seat)

		web_render.par.url = self._web_url()
		ws_tracking.par.netaddress = self.ownerComp.par.Host.eval()
		ws_tracking.par.port = int(self.ownerComp.par.Port.eval())
		ws_tracking.par.callbacks = callbacks

		web_render.par.active = True
		web_render.par.reload.pulse()
		ws_tracking.par.active = True

		self.state = 'RUNNING'
		print('SeatInput: receiving seat {}'.format(seat))

	def Stop(self):
		web_render = self.ownerComp.op('face_tracking')
		if web_render is not None:
			web_render.par.active = False

		ws_tracking = self.ownerComp.op('ws_tracking')
		if ws_tracking is not None:
			ws_tracking.par.active = False
			ws_tracking.store('tracking_registered', False)

		self.state = 'IDLE'

	def Reload(self):
		if self.state != 'RUNNING':
			return

		web_render = self.ownerComp.op('face_tracking')
		ws_tracking = self.ownerComp.op('ws_tracking')
		if web_render is None or ws_tracking is None:
			return

		web_render.par.reload.pulse()
		ws_tracking.par.active = False
		run(
			'args[0].par.active = bool(args[1].par.Active.eval())',
			ws_tracking,
			self.ownerComp,
			delayFrames=1,
		)

	def OnParameterChange(self, par):
		if par.name == 'Active':
			if par.eval():
				self.Start()
			else:
				self.Stop()
		elif par.name in ('Seat', 'Host', 'Port') and self.state == 'RUNNING':
			self.Stop()
			self.Start()

	def OnPulse(self, par):
		if par.name == 'Reload':
			self.Reload()
