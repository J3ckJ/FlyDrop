//go:build !windows

package firewall

// Apply is a no-op outside the Windows executable.
func Apply(...int) (bool, []string) { return false, nil }
