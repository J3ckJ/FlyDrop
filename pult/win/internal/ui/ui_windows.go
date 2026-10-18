//go:build windows

package ui

import (
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Presence shows and hides the banner while a phone is connected.
type Presence struct {
	hwnd uintptr
}

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	shell32         = windows.NewLazySystemDLL("shell32.dll")
	procRegister    = user32.NewProc("RegisterClassExW")
	procCreate      = user32.NewProc("CreateWindowExW")
	procDefWindow   = user32.NewProc("DefWindowProcW")
	procShow        = user32.NewProc("ShowWindow")
	procGetMessage  = user32.NewProc("GetMessageW")
	procTranslate   = user32.NewProc("TranslateMessage")
	procDispatch    = user32.NewProc("DispatchMessageW")
	procPostQuit    = user32.NewProc("PostQuitMessage")
	procLoadIcon    = user32.NewProc("LoadIconW")
	procMessageBox  = user32.NewProc("MessageBoxW")
	procShellNotify = shell32.NewProc("Shell_NotifyIconW")
	bannerHWND      atomic.Uintptr
	trayAdded       bool
)

// Start creates the tray icon and the hidden banner on the calling thread.
func Start() *Presence {
	className, _ := windows.UTF16PtrFromString("PultBanner")
	instance, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	icon, _, _ := procLoadIcon.Call(0, 32512)
	classProc = windows.NewCallback(windowProc)
	class := wndClassEx{
		WndProc:   classProc,
		Instance:  uintptr(instance),
		Icon:      icon,
		ClassName: className,
		IconSm:    icon,
	}
	class.Size = uint32(unsafe.Sizeof(class))
	procRegister.Call(uintptr(unsafe.Pointer(&class)))
	title, _ := windows.UTF16PtrFromString("Пульт управляет этим компьютером")
	hwnd, _, _ := procCreate.Call(
		0x00000088,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		0x00C80000,
		80,
		80,
		460,
		96,
		0, 0, uintptr(instance), 0,
	)
	if hwnd != 0 {
		bannerHWND.Store(hwnd)
		addTray(hwnd, icon)
	}
	ctrlProc = windows.NewCallback(consoleCtrl)
	keepHandler = ctrlProc
	_, _, _ = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler").Call(keepHandler, 1)
	return &Presence{hwnd: hwnd}
}

var (
	keepHandler uintptr
	classProc   uintptr
	ctrlProc    uintptr
)

func consoleCtrl(uint32) uintptr {
	procPostQuit.Call(0)
	return 1
}

// Set shows the banner while remote control is active.
func (p *Presence) Set(active bool) {
	if p == nil || p.hwnd == 0 {
		return
	}
	flag := uintptr(0)
	if active {
		flag = 5
	}
	procShow.Call(p.hwnd, flag)
}

// Run pumps window messages until the console asks to stop, then calls onStop.
func Run(onStop func()) {
	if bannerHWND.Load() == 0 {
		wait(onStop)
		return
	}
	var message windowMessage
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(ret) <= 0 {
			break
		}
		procTranslate.Call(uintptr(unsafe.Pointer(&message)))
		procDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
	removeTray()
	if onStop != nil {
		onStop()
	}
}

func addTray(hwnd, icon uintptr) {
	var data notifyIconData
	data.CbSize = uint32(unsafe.Sizeof(data))
	data.HWnd = hwnd
	data.UID = 1
	data.UFlags = 1 | 2 | 4
	data.UCallbackMessage = 0x0401
	data.HIcon = icon
	tip, _ := windows.UTF16FromString("Пульт")
	copy(data.SzTip[:], tip)
	procShellNotify.Call(0, uintptr(unsafe.Pointer(&data)))
	trayAdded = true
}

func removeTray() {
	if !trayAdded {
		return
	}
	var data notifyIconData
	data.CbSize = uint32(unsafe.Sizeof(data))
	data.HWnd = bannerHWND.Load()
	data.UID = 1
	procShellNotify.Call(2, uintptr(unsafe.Pointer(&data)))
	trayAdded = false
}

func windowProc(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
	switch msg {
	case 0x0010:
		procShow.Call(hwnd, 0)
		return 0
	case 0x0201, 0x0401:
		title, _ := windows.UTF16PtrFromString("Пульт")
		body, _ := windows.UTF16PtrFromString("Пульт запущен. Код сопряжения показан в окне консоли. Закрытие этой таблички не завершает Пульт.")
		procMessageBox.Call(hwnd, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0)
		return 0
	default:
		ret, _, _ := procDefWindow.Call(hwnd, uintptr(msg), wparam, lparam)
		return ret
	}
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type windowMessage struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	X       int32
	Y       int32
}

type notifyIconData struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UTimeout         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	Guid             [16]byte
	HBalloon         uintptr
}
