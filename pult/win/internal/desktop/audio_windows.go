//go:build windows

package desktop

import (
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32              = windows.NewLazySystemDLL("ole32.dll")
	procCoInitializeEx = ole32.NewProc("CoInitializeEx")
	procCoUninitialize = ole32.NewProc("CoUninitialize")
	procCoCreate       = ole32.NewProc("CoCreateInstance")
)

func masterVolume() (float64, bool, error) {
	var level float64
	var muted bool
	err := withCOM(func() error {
		volume, releaseVolume, err := endpointVolume()
		if err != nil {
			return err
		}
		defer releaseVolume()
		var step, count uint32
		if hr := callHR(volume, 16, uintptr(unsafe.Pointer(&step)), uintptr(unsafe.Pointer(&count))); failed(hr) {
			return hrError(hr)
		}
		if count > 1 {
			level = float64(step) / float64(count-1)
		}
		var mute int32
		if hr := callHR(volume, 15, uintptr(unsafe.Pointer(&mute))); failed(hr) {
			return hrError(hr)
		}
		muted = mute != 0
		return nil
	})
	return level, muted, err
}

func setVolume(level *int, muted *bool) error {
	return withCOM(func() error {
		volume, releaseVolume, err := endpointVolume()
		if err != nil {
			return err
		}
		defer releaseVolume()
		if muted != nil {
			value := uintptr(0)
			if *muted {
				value = 1
			}
			if hr := callHR(volume, 14, value, 0); failed(hr) {
				return hrError(hr)
			}
		}
		if level == nil {
			return nil
		}
		target := *level
		if target < 0 {
			target = 0
		}
		if target > 100 {
			target = 100
		}
		var step, count uint32
		if hr := callHR(volume, 16, uintptr(unsafe.Pointer(&step)), uintptr(unsafe.Pointer(&count))); failed(hr) {
			return hrError(hr)
		}
		if count < 2 {
			return nil
		}
		want := uint32(target) * (count - 1) / 100
		for step < want {
			if hr := callHR(volume, 17, 0); failed(hr) {
				return hrError(hr)
			}
			step++
		}
		for step > want {
			if hr := callHR(volume, 18, 0); failed(hr) {
				return hrError(hr)
			}
			step--
		}
		return nil
	})
}

func endpointVolume() (uintptr, func(), error) {
	var enumerator uintptr
	hr, _, _ := procCoCreate.Call(
		uintptr(unsafe.Pointer(&clsidMMDevice)),
		0,
		1,
		uintptr(unsafe.Pointer(&iidMMDevice)),
		uintptr(unsafe.Pointer(&enumerator)),
	)
	if failed(hr) || enumerator == 0 {
		return 0, nil, errors.New("Громкость недоступна")
	}
	var device uintptr
	if hr = callHR(enumerator, 4, 0, 0, uintptr(unsafe.Pointer(&device))); failed(hr) || device == 0 {
		releaseCOM(enumerator)
		return 0, nil, errors.New("Громкость недоступна")
	}
	var volume uintptr
	if hr = callHR(device, 3, uintptr(unsafe.Pointer(&iidEndpointVolume)), 1, 0, uintptr(unsafe.Pointer(&volume))); failed(hr) || volume == 0 {
		releaseCOM(device)
		releaseCOM(enumerator)
		return 0, nil, errors.New("Громкость недоступна")
	}
	return volume, func() {
		releaseCOM(volume)
		releaseCOM(device)
		releaseCOM(enumerator)
	}, nil
}

func withCOM(fn func() error) error {
	hr, _, _ := procCoInitializeEx.Call(0, 0)
	if failed(hr) && uint32(hr) != 0x80010106 {
		return errors.New("Громкость недоступна")
	}
	if !failed(hr) {
		defer procCoUninitialize.Call()
	}
	return fn()
}

func callHR(object uintptr, index int, args ...uintptr) uintptr {
	table := *(*uintptr)(unsafe.Pointer(object))
	proc := *(*uintptr)(unsafe.Pointer(table + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	call := make([]uintptr, 0, 1+len(args))
	call = append(call, object)
	call = append(call, args...)
	hr, _, _ := syscall.SyscallN(proc, call...)
	return hr
}

func releaseCOM(object uintptr) {
	if object == 0 {
		return
	}
	_ = callHR(object, 2)
}

func failed(hr uintptr) bool { return int32(hr) < 0 }

func hrError(hr uintptr) error { return windows.Errno(hr) }

var (
	clsidMMDevice     = guid{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidMMDevice       = guid{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidEndpointVolume = guid{0x5CDF2C82, 0x841E, 0x4546, [8]byte{0x97, 0x22, 0x0C, 0xF7, 0x40, 0x78, 0x22, 0x9A}}
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}
