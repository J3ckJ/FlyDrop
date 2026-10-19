//go:build !windows

package ui

import (
	"errors"
	"time"
)

// Presence is a no-op where there is no Windows tray.
type Presence struct{}

// Start reports that the tray exists only in the Windows executable.
func Start() (*Presence, error) {
	return nil, errors.New("Значок в трее есть только в Windows. Пульт продолжает работу в этом окне.")
}

// Pump does nothing outside Windows.
func Pump(time.Duration) error { return nil }

// Stop does nothing outside Windows.
func Stop(*Presence) {}

// Set does nothing outside Windows.
func (p *Presence) Set(bool) {}

// Run waits for Ctrl+C and then calls onStop.
func Run(onStop func()) {
	wait(onStop)
}
