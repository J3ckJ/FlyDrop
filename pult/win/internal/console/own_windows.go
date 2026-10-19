//go:build windows

package console

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetConsoleProcessList = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleProcessList")

// Own reports whether this process is the only one attached to its console.
// Explorer double-click allocates a console for this process alone, so the
// count is 1. A launch from an existing console counts that console too.
func Own() bool {
	var ids [16]uint32
	count, _, _ := procGetConsoleProcessList.Call(uintptr(unsafe.Pointer(&ids[0])), uintptr(len(ids)))
	return count == 1
}
