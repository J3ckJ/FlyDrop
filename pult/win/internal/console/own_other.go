//go:build !windows

package console

// Own reports whether this process is the only one attached to its console.
func Own() bool { return false }
