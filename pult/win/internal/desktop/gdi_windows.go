//go:build windows

package desktop

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func gdiJPEG() ([]byte, int, int, error) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	gdi32 := windows.NewLazySystemDLL("gdi32.dll")
	width, _, _ := user32.NewProc("GetSystemMetrics").Call(0)
	height, _, _ := user32.NewProc("GetSystemMetrics").Call(1)
	if width == 0 || height == 0 {
		return nil, 0, 0, errors.New("Экран недоступен")
	}
	hdc, _, _ := user32.NewProc("GetDC").Call(0)
	if hdc == 0 {
		return nil, 0, 0, errors.New("Экран недоступен")
	}
	defer user32.NewProc("ReleaseDC").Call(0, hdc)
	mem, _, _ := gdi32.NewProc("CreateCompatibleDC").Call(hdc)
	if mem == 0 {
		return nil, 0, 0, errors.New("Экран недоступен")
	}
	defer gdi32.NewProc("DeleteDC").Call(mem)
	bitmap, _, _ := gdi32.NewProc("CreateCompatibleBitmap").Call(hdc, width, height)
	if bitmap == 0 {
		return nil, 0, 0, errors.New("Экран недоступен")
	}
	defer gdi32.NewProc("DeleteObject").Call(bitmap)
	gdi32.NewProc("SelectObject").Call(mem, bitmap)
	const srcCopy = 0x00CC0020
	gdi32.NewProc("BitBlt").Call(mem, 0, 0, width, height, hdc, 0, 0, srcCopy)
	header := bitmapInfoHeader{
		Size:     40,
		Width:    int32(width),
		Height:   -int32(height),
		Planes:   1,
		BitCount: 32,
	}
	stride := int(width) * 4
	pix := make([]byte, stride*int(height))
	got, _, _ := gdi32.NewProc("GetDIBits").Call(mem, bitmap, 0, height, uintptr(unsafe.Pointer(&pix[0])), uintptr(unsafe.Pointer(&header)), 0)
	if got == 0 {
		return nil, 0, 0, errors.New("Экран недоступен")
	}
	return EncodeBGRA(pix, int(width), int(height), stride, 1280)
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}
