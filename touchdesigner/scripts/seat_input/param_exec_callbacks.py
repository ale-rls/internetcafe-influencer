"""Callbacks for the SeatInput/param_exec Parameter Execute DAT."""


def onValueChange(par, prev):
	me.parent().ext.SeatInputExt.OnParameterChange(par)
	return


def onPulse(par):
	me.parent().ext.SeatInputExt.OnPulse(par)
	return
