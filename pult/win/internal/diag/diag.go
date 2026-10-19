// Package diag explains whether the iPhone can reach this computer.
package diag

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Facts is what startup already measured.
type Facts struct {
	BindHTTPS  string
	BindHTTP   string
	Adapter    string
	Address    string
	HTTPSPort  int
	HTTPPort   int
	Notes      []string
	ProbeOK    bool
	ProbeError string
	Hotspot    bool
}

// Probe fetches the plain ping URL from this computer.
func Probe(url string) error {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(string(body), "ok") {
		return fmt.Errorf("ответ %d, тело %q", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// Explain is the Russian startup report.
func Explain(facts Facts) []string {
	lines := []string{"", "  Проверка с этого компьютера:"}
	lines = append(lines, "  • Привязка HTTPS: "+empty(facts.BindHTTPS))
	lines = append(lines, "  • Привязка HTTP: "+empty(facts.BindHTTP))
	if !strings.Contains(facts.BindHTTPS, "0.0.0.0") || !strings.Contains(facts.BindHTTP, "0.0.0.0") {
		lines = append(lines, "  • Сервер слушает не все интерфейсы IPv4. iPhone по адресу Wi-Fi до него не дойдёт.")
	} else {
		lines = append(lines, "  • Это 0.0.0.0, не localhost: порт открыт на всех адаптерах IPv4.")
	}
	if facts.Address == "" {
		lines = append(lines, "  • Адреса Wi-Fi или Ethernet нет. iPhone открывать нечего.")
	} else {
		lines = append(lines, fmt.Sprintf("  • Адрес для iPhone: %s · %s", facts.Address, empty(facts.Adapter)))
	}
	if facts.Hotspot {
		lines = append(lines, "  • Компьютер уже в сети точки доступа iPhone. Откройте http-адрес на этом телефоне.")
	}
	ping := fmt.Sprintf("http://%s:%d/ping", facts.Address, facts.HTTPPort)
	if facts.Address == "" {
		lines = append(lines, "  • Запрос на свой адрес не выполнялся: адреса нет.")
	} else if facts.ProbeOK {
		lines = append(lines, "  • Запрос на "+ping+": ok")
	} else {
		reason := facts.ProbeError
		if reason == "" {
			reason = "нет ответа"
		}
		lines = append(lines, "  • Запрос на "+ping+" не прошёл: "+reason)
		lines = append(lines, "  • Пока компьютер не открывает свой адрес, iPhone тоже не подключится.")
	}
	for _, note := range facts.Notes {
		lines = append(lines, "  • "+note)
	}
	lines = append(lines,
		"",
		"  Если Safari пишет, что страницу открыть не удалось, запрос до компьютера не дошёл.",
		"  Проверка выше идёт с самого компьютера. Путь с телефона другой.",
		"  Kaspersky (сетевой экран и «Мониторинг сетевых атак») может отбрасывать входящие на порт Пульта, даже когда правило Windows есть. Защиту и контроль программ не отключайте. Если всплыло окно про pult.exe — разрешите ему входящие. Если окна не было, в отчёте сетевого экрана Kaspersky разрешите pult.exe сеть.",
		"  Корпоративный Wi-Fi часто изолирует клиентов: телефон и компьютер в одной сети друг друга не видят. Пульт эту настройку точки доступа не обходит.",
		"",
		"  Запасной путь — точка доступа iPhone. Компьютер сам подключается к телефону:",
		"  1. iPhone: Настройки → Режим модема → разрешить другим.",
		"  2. Компьютер: подключиться к этой сети Wi-Fi.",
		"  3. Параметры Windows → Сеть → эта сеть → Частная. Общедоступную сеть Пульт не открывает.",
		"  4. Новый адрес 172.20.10.x появится в этом окне. Если нет — запустите pult.exe ещё раз.",
		"  5. На том же iPhone сначала откройте http://172.20.10.x:4721/setup, затем http://172.20.10.x:4721/ping — на экране ok.",
		"",
	)
	return lines
}

func empty(value string) string {
	if value == "" {
		return "нет"
	}
	return value
}
