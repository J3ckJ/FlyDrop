//go:build windows

package desktop

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func readClipboard() (string, error) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	opened, _, err := user32.NewProc("OpenClipboard").Call(0)
	if opened == 0 {
		return "", clipboardError(err)
	}
	defer user32.NewProc("CloseClipboard").Call()
	handle, _, _ := user32.NewProc("GetClipboardData").Call(13)
	if handle == 0 {
		return "", nil
	}
	ptr, _, lockErr := kernel32.NewProc("GlobalLock").Call(handle)
	if ptr == 0 {
		return "", clipboardError(lockErr)
	}
	defer kernel32.NewProc("GlobalUnlock").Call(handle)
	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(ptr))), nil
}

func writeClipboard(text string) error {
	user32 := windows.NewLazySystemDLL("user32.dll")
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	opened, _, err := user32.NewProc("OpenClipboard").Call(0)
	if opened == 0 {
		return clipboardError(err)
	}
	defer user32.NewProc("CloseClipboard").Call()
	user32.NewProc("EmptyClipboard").Call()
	units, convErr := windows.UTF16FromString(text)
	if convErr != nil {
		return convErr
	}
	size := uintptr(len(units) * 2)
	const moveable = 0x0002
	handle, _, allocErr := kernel32.NewProc("GlobalAlloc").Call(moveable, size)
	if handle == 0 {
		return clipboardError(allocErr)
	}
	ptr, _, lockErr := kernel32.NewProc("GlobalLock").Call(handle)
	if ptr == 0 {
		kernel32.NewProc("GlobalFree").Call(handle)
		return clipboardError(lockErr)
	}
	copy((*[1 << 20]uint16)(unsafe.Pointer(ptr))[:len(units)], units)
	kernel32.NewProc("GlobalUnlock").Call(handle)
	set, _, setErr := user32.NewProc("SetClipboardData").Call(13, handle)
	if set == 0 {
		kernel32.NewProc("GlobalFree").Call(handle)
		return clipboardError(setErr)
	}
	return nil
}

func clipboardError(err error) error {
	if err != nil && err != windows.ERROR_SUCCESS {
		return err
	}
	return errors.New("Буфер обмена недоступен")
}
