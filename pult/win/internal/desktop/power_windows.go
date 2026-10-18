//go:build windows

package desktop

import (
	"errors"

	"golang.org/x/sys/windows"
)

func powerAction(action string) error {
	user32 := windows.NewLazySystemDLL("user32.dll")
	switch action {
	case "lock":
		ret, _, err := user32.NewProc("LockWorkStation").Call()
		if ret == 0 {
			return callError(err, "Не удалось заблокировать")
		}
		return nil
	case "sleep":
		ret, _, err := windows.NewLazySystemDLL("powrprof.dll").NewProc("SetSuspendState").Call(0, 1, 0)
		if ret == 0 {
			return callError(err, "Не удалось усыпить")
		}
		return nil
	case "restart":
		return exitWindows(0x00000002 | 0x00000010)
	case "shutdown":
		return exitWindows(0x00000001 | 0x00000010)
	default:
		return errors.New("Неизвестное действие питания")
	}
}

func exitWindows(flags uintptr) error {
	if err := enableShutdown(); err != nil {
		return err
	}
	ret, _, err := windows.NewLazySystemDLL("user32.dll").NewProc("ExitWindowsEx").Call(flags, 0)
	if ret == 0 {
		return callError(err, "Нет права на выключение. Запустите pult.exe от администратора один раз: правый щелчок → Запуск от имени администратора. Пульт сам повышение не запрашивает.")
	}
	return nil
}

func enableShutdown() error {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return errors.New("Нет права на выключение. Запустите pult.exe от администратора один раз: правый щелчок → Запуск от имени администратора. Пульт сам повышение не запрашивает.")
	}
	defer token.Close()
	name, err := windows.UTF16PtrFromString("SeShutdownPrivilege")
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		return err
	}
	privs := windows.Tokenprivileges{PrivilegeCount: 1}
	privs.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	if err := windows.AdjustTokenPrivileges(token, false, &privs, 0, nil, nil); err != nil {
		return errors.New("Нет права на выключение. Запустите pult.exe от администратора один раз: правый щелчок → Запуск от имени администратора. Пульт сам повышение не запрашивает.")
	}
	return nil
}

func callError(err error, fallback string) error {
	if err != nil && err != windows.ERROR_SUCCESS {
		if err == windows.ERROR_ACCESS_DENIED || err == windows.ERROR_PRIVILEGE_NOT_HELD {
			return errors.New("Нет права на выключение. Запустите pult.exe от администратора один раз: правый щелчок → Запуск от имени администратора. Пульт сам повышение не запрашивает.")
		}
		return err
	}
	return errors.New(fallback)
}
