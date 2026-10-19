//go:build windows

package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"github.com/go-mswin/screencapture"
	"golang.org/x/sys/windows"
)

// Session is the interactive Windows desktop. It does not start a shell.
type Session struct {
	mu          sync.Mutex
	stream      *screencapture.Stream
	stopCapture context.CancelFunc
	last        []byte
	lastW       int
	lastH       int
	appsRoot    []string
}

// Compile-time check: SendInput on amd64 takes a 40-byte INPUT.
var _ = map[bool]struct{}{false: {}, unsafe.Sizeof(mouseInput{}) == 40: {}}
var _ = map[bool]struct{}{false: {}, unsafe.Sizeof(keyInput{}) == 40: {}}

// Open prepares the desktop session.
func Open() *Session {
	roots := []string{}
	if programData := os.Getenv("PROGRAMDATA"); programData != "" {
		roots = append(roots, filepath.Join(programData, "Microsoft", "Windows", "Start Menu", "Programs"))
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		roots = append(roots, filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs"))
	}
	return &Session{appsRoot: roots}
}

func (s *Session) Status() (Status, error) {
	level, muted, err := masterVolume()
	running := []string{}
	if err != nil {
		return Status{Volume: nil, Muted: false, AppsRunning: running, Media: nil, Battery: nil}, nil
	}
	value := int(level*100 + 0.5)
	return Status{Volume: &value, Muted: muted, AppsRunning: running, Media: nil, Battery: nil}, nil
}

func (s *Session) Capture() ([]byte, int, int, error) {
	return s.captureFrame()
}

func (s *Session) Move(dx, dy int) error {
	return sendMouse(dx, dy, 0x0001, 0)
}

func (s *Session) Click(button string, count int) error {
	down, up := uint32(0x0002), uint32(0x0004)
	switch button {
	case "right":
		down, up = 0x0008, 0x0010
	case "middle":
		down, up = 0x0020, 0x0040
	}
	if count < 1 {
		count = 1
	}
	for i := 0; i < count; i++ {
		if err := sendMouse(0, 0, down, 0); err != nil {
			return err
		}
		if err := sendMouse(0, 0, up, 0); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) Scroll(_, dy int) error {
	delta := 120
	if dy < 0 {
		delta = -120
	}
	if dy == 0 {
		return nil
	}
	return sendMouse(0, 0, 0x0800, uint32(delta))
}

func (s *Session) Key(key string, down bool) error {
	vk := virtualKey(key)
	if vk == 0 {
		return errors.New("Некорректная клавиша")
	}
	flags := uint32(0)
	if !down {
		flags = 0x0002
	}
	return sendKey(uint32(vk), 0, flags)
}

func (s *Session) Text(text string) error {
	for _, unit := range utf16.Encode([]rune(text)) {
		if err := sendKey(0, uint32(unit), 0x0004); err != nil {
			return err
		}
		if err := sendKey(0, uint32(unit), 0x0004|0x0002); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) Volume(level *int, muted *bool) error {
	return setVolume(level, muted)
}

func (s *Session) Media(action string) error {
	key := uint16(0xB3)
	switch action {
	case "next":
		key = 0xB0
	case "previous":
		key = 0xB1
	}
	if err := sendKey(uint32(key), 0, 0); err != nil {
		return err
	}
	return sendKey(uint32(key), 0, 0x0002)
}

func (s *Session) Apps() ([]App, error) {
	var out []App
	for _, root := range s.appsRoot {
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() || len(out) >= 80 {
				if len(out) >= 80 {
					return filepath.SkipAll
				}
				return nil
			}
			if strings.EqualFold(filepath.Ext(entry.Name()), ".lnk") {
				out = append(out, App{ID: path, Name: strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())), Running: false})
			}
			return nil
		})
	}
	if out == nil {
		out = []App{}
	}
	return out, nil
}

func (s *Session) Launch(id string) error {
	if !allowedLaunch(id, s.appsRoot) {
		return errors.New("Можно открыть только ярлык из меню Пуск")
	}
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(id)
	if err != nil {
		return err
	}
	proc := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")
	ret, _, callErr := proc.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if ret <= 32 {
		if callErr != syscall.Errno(0) {
			return callErr
		}
		return errors.New("Не удалось открыть программу")
	}
	return nil
}

func (s *Session) Clipboard() (string, error) { return readClipboard() }

func (s *Session) SetClipboard(text string) error { return writeClipboard(text) }

func (s *Session) Notifications() ([]Note, error) { return []Note{}, nil }

func (s *Session) Power(action string) error { return powerAction(action) }

func (s *Session) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var err error
	if s.stream != nil {
		err = s.stream.Close()
		s.stream = nil
	}
	if s.stopCapture != nil {
		s.stopCapture()
		s.stopCapture = nil
	}
	return err
}

func virtualKey(key string) uint16 {
	switch key {
	case "enter":
		return 13
	case "escape":
		return 27
	case "tab":
		return 9
	case "backspace":
		return 8
	case "space":
		return 32
	case "left":
		return 37
	case "up":
		return 38
	case "right":
		return 39
	case "down":
		return 40
	case "ctrl":
		return 17
	case "alt":
		return 18
	case "shift":
		return 16
	case "win", "meta":
		return 0x5B
	}
	if len(key) == 2 && key[0] == 'f' {
		n := int(key[1] - '0')
		if n >= 1 && n <= 9 {
			return uint16(111 + n)
		}
	}
	if key == "f10" {
		return 121
	}
	if key == "f11" {
		return 122
	}
	if key == "f12" {
		return 123
	}
	if len(key) == 1 {
		r := key[0]
		if r >= 'a' && r <= 'z' {
			return uint16(r - 'a' + 'A')
		}
		if r >= '0' && r <= '9' {
			return uint16(r)
		}
	}
	return 0
}

type mouseInput struct {
	Type      uint32
	_         uint32
	Dx        int32
	Dy        int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	_         uint32
	Extra     uintptr
}

type keyInput struct {
	Type  uint32
	_     uint32
	Vk    uint16
	Scan  uint16
	Flags uint32
	Time  uint32
	_     uint32
	Extra uintptr
	_     [8]byte
}

func sendMouse(dx, dy int, flags, data uint32) error {
	input := mouseInput{Type: 0, Dx: int32(dx), Dy: int32(dy), MouseData: data, Flags: flags}
	return sendInput(unsafe.Pointer(&input), unsafe.Sizeof(input))
}

func sendKey(vk, scan, flags uint32) error {
	input := keyInput{Type: 1, Vk: uint16(vk), Scan: uint16(scan), Flags: flags}
	return sendInput(unsafe.Pointer(&input), unsafe.Sizeof(input))
}

func sendInput(input unsafe.Pointer, size uintptr) error {
	proc := windows.NewLazySystemDLL("user32.dll").NewProc("SendInput")
	ret, _, err := proc.Call(1, uintptr(input), size)
	if ret != 1 {
		if err != syscall.Errno(0) {
			return err
		}
		return errors.New("Ввод не отправлен")
	}
	return nil
}
