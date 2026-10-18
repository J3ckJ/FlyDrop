//go:build windows

package firewall

import (
	"strconv"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// Apply adds an inbound TCP rule for the private profile through the documented firewall COM API.
func Apply(port int) (bool, []string) {
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		return false, []string{"Брандмауэр Windows недоступен. Если iPhone не открывается, запустите pult.exe от администратора один раз."}
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
	if err != nil {
		return false, []string{adminHint()}
	}
	rules := rulesValue.ToIDispatch()
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
	_, _ = oleutil.PutProperty(rule, "LocalPorts", strconv.Itoa(port))
	_, _ = oleutil.PutProperty(rule, "Direction", int32(1))
	_, _ = oleutil.PutProperty(rule, "Action", int32(1))
	_, _ = oleutil.PutProperty(rule, "Enabled", true)
	_, _ = oleutil.PutProperty(rule, "Profiles", int32(ProfilePrivate))
	if _, err = oleutil.CallMethod(rules, "Add", rule); err != nil {
		return false, []string{adminHint()}
	}
	return true, []string{"Для частной сети добавлено входящее правило TCP " + strconv.Itoa(port) + "."}
}

func adminHint() string {
	return "Правило брандмауэра не добавлено. Запустите pult.exe от администратора один раз: правый щелчок → Запуск от имени администратора. Пульт сам повышение не запрашивает и общедоступную сеть не открывает."
}
