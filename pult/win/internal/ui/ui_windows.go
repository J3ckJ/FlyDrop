//go:build windows

package ui

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Presence shows and hides the banner while a phone is connected.
type Presence struct {
	hwnd uintptr
}

var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	shell32          = windows.NewLazySystemDLL("shell32.dll")
	procRegister     = user32.NewProc("RegisterClassExW")
	procCreate       = user32.NewProc("CreateWindowExW")
	procDestroy      = user32.NewProc("DestroyWindow")
	procDefWindow    = user32.NewProc("DefWindowProcW")
	procShow         = user32.NewProc("ShowWindow")
	procGetMessage   = user32.NewProc("GetMessageW")
	procPeekMessage  = user32.NewProc("PeekMessageW")
	procPostMessage  = user32.NewProc("PostMessageW")
	procTranslate    = user32.NewProc("TranslateMessage")
	procDispatch     = user32.NewProc("DispatchMessageW")
	procPostQuit     = user32.NewProc("PostQuitMessage")
	procLoadIcon     = user32.NewProc("LoadIconW")
	procMessageBox   = user32.NewProc("MessageBoxW")
	procShellNotify  = shell32.NewProc("Shell_NotifyIconW")
	bannerHWND       atomic.Uintptr
	trayAdded        bool
	threadLocked     bool
	handlerInstalled bool
)

const msgStop = 0x8001

// Start creates the tray icon and the hidden banner on this goroutine's OS thread.
// The caller must use Run or Stop on the same goroutine. A failure here is not fatal.
func Start() (presence *Presence, err error) {
	runtime.LockOSThread()
	threadLocked = true
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("Трей вызвал сбой и пропущен: %v", recovered)
			presence = nil
			finishThread()
		}
	}()
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
	hwnd, _, callErr := procCreate.Call(
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
	if hwnd == 0 {
		finishThread()
		return nil, fmt.Errorf("Значок в трее не создан (%v). Пульт продолжает работу в этом окне.", callErr)
	}
	bannerHWND.Store(hwnd)
	addTray(hwnd, icon)
	return &Presence{hwnd: hwnd}, nil
}

// Pump dispatches queued window messages until the duration ends.
// An immediate WM_QUIT or a failed read means a double-clicked console would close.
func Pump(d time.Duration) error {
	if bannerHWND.Load() == 0 {
		return nil
	}
	deadline := time.Now().Add(d)
	var message windowMessage
	for time.Now().Before(deadline) {
		ret, _, _ := procPeekMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, 1)
		if int32(ret) < 0 {
			return errors.New("Окно трея вернуло ошибку сообщения. Консоль закрылась бы сразу.")
		}
		if ret == 0 {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		if message.Message == 0x0012 {
			return errors.New("Окно трея получило WM_QUIT сразу после старта. Консоль закрылась бы сразу.")
		}
		procTranslate.Call(uintptr(unsafe.Pointer(&message)))
		procDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
	return nil
}

// Stop removes the tray icon. It must run on the goroutine that called Start.
func Stop(p *Presence) {
	removeTray()
	if p != nil && p.hwnd != 0 {
		procDestroy.Call(p.hwnd)
	}
	bannerHWND.Store(0)
	finishThread()
}

var (
	keepHandler uintptr
	classProc   uintptr
	ctrlProc    uintptr
)

func installHandler() {
	if handlerInstalled {
		return
	}
	ctrlProc = windows.NewCallback(consoleCtrl)
	keepHandler = ctrlProc
	_, _, _ = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler").Call(keepHandler, 1)
	handlerInstalled = true
}

func consoleCtrl(kind uint32) uintptr {
	switch kind {
	case 0, 1, 2, 5, 6:
		hwnd := bannerHWND.Load()
		if hwnd != 0 {
			procPostMessage.Call(hwnd, msgStop, 0, 0)
		}
		return 1
	default:
		return 0
	}
}

func finishThread() {
	if !threadLocked {
		return
	}
	threadLocked = false
	runtime.UnlockOSThread()
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
// A failed message call keeps the console open instead of exiting.
func Run(onStop func()) {
	defer finishThread()
	if bannerHWND.Load() == 0 {
		wait(onStop)
		return
	}
	installHandler()
	var message windowMessage
	broken := false
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if ret == 0 {
			break
		}
		if int32(ret) < 0 {
			fmt.Fprintln(os.Stderr, "Окно трея не принимает сообщения. Пульт остаётся в этом окне консоли.")
			broken = true
			break
		}
		procTranslate.Call(uintptr(unsafe.Pointer(&message)))
		procDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
	removeTray()
	if broken {
		wait(onStop)
		return
	}
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

func windowProc(hwnd uintptr, msg uint32, wparam, lparam uintptr) (result uintptr) {
	defer func() { _ = recover() }()
	switch msg {
	case 0x0010:
		procShow.Call(hwnd, 0)
		return 0
	case msgStop:
		procPostQuit.Call(0)
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
