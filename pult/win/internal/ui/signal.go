package ui

import (
	"os"
	"os/signal"
	"syscall"
)

func wait(onStop func()) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	signal.Stop(signals)
	if onStop != nil {
		onStop()
	}
}
