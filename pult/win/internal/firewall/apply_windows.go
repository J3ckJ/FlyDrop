//go:build windows

package firewall

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// Apply adds an inbound TCP rule for the private profile through the documented firewall COM API.
// COM stays on one OS thread. A failure or a panic is returned as a note and does not stop Пульт.
func Apply(ports ...int) (ok bool, notes []string) {
	defer func() {
		if recovered := recover(); recovered != nil {
			ok = false
			notes = []string{fmt.Sprintf("Брандмауэр Windows вызвал сбой и пропущен: %v", recovered)}
		}
	}()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	return apply(ports...)
}

func apply(ports ...int) (bool, []string) {
	list := make([]string, 0, len(ports))
	for _, port := range ports {
		if port > 0 && port < 65536 {
			list = append(list, strconv.Itoa(port))
		}
	}
	if len(list) == 0 {
		return false, []string{"Порт для правила брандмауэра не задан."}
	}
	portList := strings.Join(list, ",")
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		return false, []string{fmt.Sprintf("Брандмауэр Windows пропущен: %v. Пульт продолжает работу. Защиту антивируса не отключайте.", err)}
	}
	defer ole.CoUninitialize()
	unknown, err := oleutil.CreateObject("HNetCfg.FwPolicy2")
	if err != nil {
		return false, []string{"Брандмауэр Windows недоступен. Если iPhone не открывается, запустите pult.exe от администратора один раз."}
	}
	defer unknown.Release()
	policy, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return false, []string{"Брандмауэр Windows недоступен."}
	}
	defer policy.Release()
	current, err := oleutil.GetProperty(policy, "CurrentProfileTypes")
	if err != nil {
		return false, []string{"Не удалось прочитать профиль сети. Правило не добавляется."}
	}
	bits := int(current.Val)
	current.Clear()
	decision := Decide(bits)
	if !decision.Apply {
		return false, []string{decision.Reason}
	}
	rulesValue, err := oleutil.GetProperty(policy, "Rules")
	if err != nil || rulesValue == nil {
		return false, []string{adminHint()}
	}
	rules := rulesValue.ToIDispatch()
	if rules == nil {
		rulesValue.Clear()
		return false, []string{"Брандмауэр вернул пустой список правил. Правило пропущено, Пульт продолжает работу."}
	}
	defer rules.Release()
	_, _ = oleutil.CallMethod(rules, "Remove", "Pult")
	ruleUnknown, err := oleutil.CreateObject("HNetCfg.FWRule")
	if err != nil {
		return false, []string{adminHint()}
	}
	defer ruleUnknown.Release()
	rule, err := ruleUnknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return false, []string{adminHint()}
	}
	defer rule.Release()
	_, _ = oleutil.PutProperty(rule, "Name", "Pult")
	_, _ = oleutil.PutProperty(rule, "Description", "Входящие подключения Пульта в частной сети")
	_, _ = oleutil.PutProperty(rule, "Protocol", int32(6))
	_, _ = oleutil.PutProperty(rule, "LocalPorts", portList)
	_, _ = oleutil.PutProperty(rule, "Direction", int32(1))
	_, _ = oleutil.PutProperty(rule, "Action", int32(1))
	_, _ = oleutil.PutProperty(rule, "Enabled", true)
	_, _ = oleutil.PutProperty(rule, "Profiles", int32(ProfilePrivate))
	if _, err = oleutil.CallMethod(rules, "Add", rule); err != nil {
		return false, []string{adminHint()}
	}
	return true, []string{"Для частной сети добавлено входящее правило TCP " + portList + "."}
}

func adminHint() string {
	return "Правило брандмауэра не добавлено. Запустите pult.exe от администратора один раз: правый щелчок → Запуск от имени администратора. Пульт сам повышение не запрашивает и общедоступную сеть не открывает."
}
