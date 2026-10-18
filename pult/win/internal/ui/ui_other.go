//go:build !windows

package ui

// Presence is a no-op where there is no Windows tray.
type Presence struct{}

// Start does nothing outside Windows.
func Start() *Presence { return &Presence{} }

// Set does nothing outside Windows.
func (p *Presence) Set(bool) {}

// Run waits for Ctrl+C and then calls onStop.
func Run(onStop func()) {
	wait(onStop)
}
