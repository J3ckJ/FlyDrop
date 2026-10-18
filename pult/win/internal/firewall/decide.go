// Package firewall decides whether a private-network rule may be added.
package firewall

const (
	ProfileDomain  = 1
	ProfilePrivate = 2
	ProfilePublic  = 4
)

// Decision is what the executable should do with the Windows Firewall API.
type Decision struct {
	Apply  bool
	Reason string
}

// Decide refuses a public profile. A private profile may receive an inbound TCP rule.
func Decide(profileBits int) Decision {
	switch {
	case profileBits&ProfilePublic != 0:
		return Decision{Apply: false, Reason: "Сеть сейчас общедоступная. Пульт не открывает порт в общедоступном профиле. Параметры → Сеть и Интернет → Wi-Fi → ваша сеть → Частная."}
	case profileBits&ProfilePrivate != 0:
		return Decision{Apply: true, Reason: "Для частной сети будет добавлено входящее правило TCP."}
	case profileBits&ProfileDomain != 0:
		return Decision{Apply: false, Reason: "Сеть в домене. Правило частного профиля на неё не действует."}
	default:
		return Decision{Apply: false, Reason: "Профиль сети не определён. Правило не добавляется."}
	}
}
