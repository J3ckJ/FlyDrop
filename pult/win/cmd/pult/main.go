package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	qrterminal "github.com/mdp/qrterminal/v3"

	"github.com/J3ckJ/FlyDrop/pult/win/internal/agent"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/bootlog"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/cert"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/console"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/diag"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/firewall"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/lan"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/mdns"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/paths"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/store"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/ui"
)

func main() {
	var code int
	var selftest bool
	defer func() {
		if recovered := recover(); recovered != nil {
			bootlog.Panic(recovered)
			code = 1
		}
		bootlog.Close()
		if console.ShouldPause(selftest, console.Own()) {
			console.Pause()
		}
		if code != 0 {
			os.Exit(code)
		}
	}()
	bootlog.Open()
	code = run(&selftest)
}

func run(selftest *bool) int {
	fs := flag.NewFlagSet("pult", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	portFlag := fs.Int("port", 4720, "порт HTTPS")
	nameFlag := fs.String("name", "", "имя компьютера")
	dataFlag := fs.String("data", "", "каталог данных")
	noFirewall := fs.Bool("no-firewall", false, "не менять брандмауэр")
	noMDNS := fs.Bool("no-mdns", false, "не объявлять компьютер в локальной сети")
	revoke := fs.String("revoke", "", "снять сопряжение телефона")
	selftestFlag := fs.Bool("selftest", false, "проверка запуска: сертификат, порты 4720 и 4721, брандмауэр, трей, экран, mDNS")
	if err := fs.Parse(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Не удалось разобрать параметры.")
		return 2
	}
	*selftest = *selftestFlag
	where := bootlog.Paths()
	if len(where) > 0 {
		fmt.Printf("Журнал: %s\n", strings.Join(where, " и "))
	}
	if *selftestFlag {
		return runSelftest(*dataFlag)
	}
	bootlog.Stage("каталог данных")
	dir, notes, err := paths.Choose(*dataFlag)
	for _, note := range notes {
		bootlog.Printf("%s", note)
		fmt.Println(note)
	}
	if err != nil {
		return fail(err)
	}
	bootlog.Printf("данные: %s", dir)
	fmt.Printf("Данные: %s\n", dir)
	bootlog.Stage("хранилище телефонов")
	phones, err := store.Open(dir)
	if err != nil {
		return fail(fmt.Errorf("Не удалось открыть список телефонов: %w", err))
	}
	if *revoke != "" {
		bootlog.Stage("снятие сопряжения")
		removed, err := phones.Revoke(*revoke)
		if err != nil {
			return fail(err)
		}
		if removed {
			fmt.Println("Телефон удалён из сопряжённых.")
		} else {
			fmt.Println("Такого телефона нет.")
		}
		return 0
	}
	name := strings.TrimSpace(*nameFlag)
	if name == "" {
		name, _ = os.Hostname()
	}
	if name == "" {
		name = "Pult"
	}
	bootlog.Stage("адаптеры")
	phone, skipped, mac, err := lan.Interfaces()
	if err != nil {
		bootlog.Printf("адаптеры: %v", err)
		fmt.Println("  Список адаптеров недоступен:", err)
	}
	addresses := []string{"127.0.0.1"}
	for _, adapter := range phone {
		addresses = append(addresses, adapter.Address)
	}
	bootlog.Stage("сертификат")
	material, err := cert.Load(dir, addresses)
	if err != nil {
		return fail(fmt.Errorf("Не удалось записать сертификат в %s: %w", dir, err))
	}
	bootlog.Printf("отпечаток: %s", material.Fingerprint)
	downloads := downloadDir()
	server := agent.New(openDesktop(), phones)
	server.Name = name
	server.Addresses = addresses
	server.Downloads = downloads
	server.MAC = mac
	server.HostID = phones.HostID()
	server.CA = material.CADer
	server.Fingerprint = material.Fingerprint
	bootlog.Stage("привязка 0.0.0.0")
	serveErrors := startServer(server, material, *portFlag)
	if err := waitListen(server, serveErrors); err != nil {
		return fail(err)
	}
	bootlog.Printf("слушает %s и %s", server.Bound(), server.PlainBound())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	printConsole(server, phone, skipped, material.Fingerprint)
	bootlog.Stage("брандмауэр")
	firewallNotes := []string{"Проверка брандмауэра выключена (--no-firewall)."}
	if !*noFirewall {
		firewallNotes = applyFirewall(server.Port(), server.HTTPPort())
	}
	for _, note := range firewallNotes {
		bootlog.Printf("брандмауэр: %s", note)
	}
	report(server, phone, firewallNotes)
	go watchNetwork(ctx, server, *noFirewall)
	bootlog.Stage("mDNS")
	if *noMDNS {
		bootlog.Printf("mDNS выключен параметром")
	} else if err := announce(ctx, server, phones, phone, material.Fingerprint); err != nil {
		bootlog.Printf("mDNS: %v", err)
		fmt.Println(" ", err)
		fmt.Println("  iPhone может открыть адрес из этого окна вручную. Объявление в сети для этого не нужно.")
	}
	bootlog.Stage("трей")
	presence, err := ui.Start()
	if err != nil {
		bootlog.Printf("трей: %v", err)
		fmt.Println(" ", err)
		presence = nil
	}
	server.OnPresence = func(connected bool) { presence.Set(connected) }
	bootlog.Stage("готов, ожидание телефона")
	fmt.Println("  Телефон вводит этот код. Без кода управление недоступно.")
	fmt.Println("  Телефон и компьютер — в одной Wi-Fi.")
	fmt.Println("  Закройте это окно или нажмите Ctrl+C, чтобы завершить Пульт.")
	fmt.Println()
	bootlog.Stage("экран откроется по запросу телефона, не при старте")
	ui.Run(func() {
		cancel()
		_ = server.Close()
	})
	return 0
}

func startServer(server *agent.Server, material cert.Material, port int) <-chan error {
	serveErrors := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				serveErrors <- fmt.Errorf("Сбой при запуске сервера: %v\n%s", recovered, debug.Stack())
			}
		}()
		serveErrors <- server.Serve(material, port)
	}()
	return serveErrors
}

func waitListen(server *agent.Server, serveErrors <-chan error) error {
	deadline := time.Now().Add(5 * time.Second)
	for (server.Port() == 0 || server.HTTPPort() == 0) && time.Now().Before(deadline) {
		select {
		case err := <-serveErrors:
			if err == nil {
				return errors.New("Сервер остановился сразу после старта")
			}
			return err
		default:
			time.Sleep(20 * time.Millisecond)
		}
	}
	if server.Port() == 0 || server.HTTPPort() == 0 {
		return errors.New("Порт не открылся")
	}
	if !strings.Contains(server.Bound(), "0.0.0.0:") || !strings.Contains(server.PlainBound(), "0.0.0.0:") {
		return fmt.Errorf("Сервер слушает %s и %s, а нужен адрес 0.0.0.0", server.Bound(), server.PlainBound())
	}
	return nil
}

func applyFirewall(ports ...int) []string {
	type result struct {
		notes []string
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- result{notes: []string{fmt.Sprintf("Брандмауэр Windows вызвал сбой и пропущен: %v", recovered)}}
			}
		}()
		_, notes := firewall.Apply(ports...)
		done <- result{notes: notes}
	}()
	select {
	case got := <-done:
		if len(got.notes) == 0 {
			return []string{"Брандмауэр Windows ничего не ответил. Пульт продолжает работу."}
		}
		return got.notes
	case <-time.After(15 * time.Second):
		return []string{"Брандмауэр Windows не ответил за 15 с. Пульт продолжает работу без нового правила. Защиту антивируса не отключайте."}
	}
}

func announce(ctx context.Context, server *agent.Server, phones *store.Store, phone []lan.Adapter, fingerprint string) error {
	if len(phone) == 0 {
		return errors.New("Объявление в локальной сети пропущено: нет адреса Wi-Fi или Ethernet.")
	}
	if err := mdns.Probe(); err != nil {
		bootlog.Printf("mDNS: %v", err)
		fmt.Println(" ", err)
		fmt.Println("  Это не мешает работе. Корпоративный Wi-Fi часто запрещает multicast. Адрес выше открывается вручную.")
	}
	addresses := make([]string, 0, len(phone))
	for _, adapter := range phone {
		addresses = append(addresses, adapter.Address)
	}
	host := phones.HostID()
	if len(host) > 8 {
		host = host[:8]
	}
	packet, err := mdns.BuildAnnouncement(sanitize(server.Name), host+".local", server.Port(), addresses, map[string]string{
		"os": "windows", "ver": "1", "fp": fingerprintShort(fingerprint), "fly": fmt.Sprint(server.Port()),
	})
	if err != nil {
		return err
	}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				bootlog.Printf("mDNS остановился: %v", recovered)
			}
		}()
		mdns.Advertise(ctx, packet)
	}()
	return nil
}

func fail(err error) int {
	bootlog.Fail(err)
	return 1
}

func printConsole(server *agent.Server, phone, skipped []lan.Adapter, fingerprint string) {
	fmt.Println()
	fmt.Println("  Пульт")
	fmt.Printf("  Компьютер: %s · windows\n", server.Name)
	fmt.Printf("  Код сопряжения: %s\n", server.Code())
	fmt.Printf("  Слушает IPv4 %s и %s. Это не localhost.\n", server.Bound(), server.PlainBound())
	if len(phone) > 0 {
		printPhone(phone[0], server)
		for _, extra := range phone[1:] {
			fmt.Printf("  Ещё адрес: http://%s:%d/setup  ·  %s\n", extra.Address, server.HTTPPort(), extra.Name)
		}
	} else {
		fmt.Println("  Не найден адаптер Wi-Fi или Ethernet в локальной сети.")
		fmt.Println("  Включите на iPhone режим модема и подключите к нему этот компьютер.")
	}
	if len(skipped) > 0 {
		fmt.Println("  Не открывайте эти адреса на iPhone — это виртуальные или локальные адаптеры:")
		for _, item := range skipped {
			fmt.Printf("    %s  %s\n", item.Name, item.Address)
		}
	}
	fmt.Printf("  На этом компьютере: http://127.0.0.1:%d/ping и https://localhost:%d/\n", server.HTTPPort(), server.Port())
	fmt.Printf("  Отпечаток: %s\n", fingerprint)
	if server.MAC != "" {
		fmt.Printf("  MAC для Wake-on-LAN: %s\n", server.MAC)
	}
	fmt.Printf("  Файлы с iPhone: %s\n", server.Downloads)
	fmt.Println("  Уведомления Windows Пульт не читает: обычной программе Центр уведомлений недоступен.")
}

func printPhone(adapter lan.Adapter, server *agent.Server) {
	if lan.IsHotspot(adapter.Address) {
		fmt.Println("  Компьютер подключён к точке доступа iPhone. Откройте адрес на этом телефоне.")
	}
	setup := fmt.Sprintf("http://%s:%d/setup", adapter.Address, server.HTTPPort())
	page := fmt.Sprintf("https://%s:%d/", adapter.Address, server.Port())
	fmt.Printf("  Адаптер: %s\n", adapter.Name)
	fmt.Println("  Сначала на iPhone, обычный HTTP, сертификат ещё не нужен:")
	fmt.Printf("  %s\n", setup)
	qrterminal.GenerateHalfBlock(setup, qrterminal.M, os.Stdout)
	fmt.Printf("  Проверка: http://%s:%d/ping — на экране должно быть ok\n", adapter.Address, server.HTTPPort())
	fmt.Println("  После профиля и доверия сертификату:")
	fmt.Printf("  %s\n", page)
	qrterminal.GenerateHalfBlock(page, qrterminal.M, os.Stdout)
}

func report(server *agent.Server, phone []lan.Adapter, notes []string) {
	facts := diag.Facts{
		BindHTTPS: server.Bound(),
		BindHTTP:  server.PlainBound(),
		HTTPSPort: server.Port(),
		HTTPPort:  server.HTTPPort(),
		Notes:     notes,
	}
	if len(phone) > 0 {
		facts.Address = phone[0].Address
		facts.Adapter = phone[0].Name
		facts.Hotspot = lan.IsHotspot(phone[0].Address)
		err := diag.Probe(fmt.Sprintf("http://%s:%d/ping", phone[0].Address, server.HTTPPort()))
		if err != nil {
			facts.ProbeError = err.Error()
		} else {
			facts.ProbeOK = true
		}
	}
	for _, line := range diag.Explain(facts) {
		fmt.Println(line)
		bootlog.Printf("%s", strings.TrimSpace(line))
	}
}

func watchNetwork(ctx context.Context, server *agent.Server, skipFirewall bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			bootlog.Printf("наблюдение за сетью остановилось: %v", recovered)
		}
	}()
	last := ""
	if phone, _, _, err := lan.Interfaces(); err == nil && len(phone) > 0 {
		last = phone[0].Address
	}
	ticker := time.NewTicker(8 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			phone, _, _, err := lan.Interfaces()
			if err != nil || len(phone) == 0 || phone[0].Address == last {
				continue
			}
			last = phone[0].Address
			fmt.Println()
			fmt.Println("  Сеть сменилась.")
			printPhone(phone[0], server)
			notes := []string{"Проверка брандмауэра выключена (--no-firewall)."}
			if !skipFirewall {
				notes = applyFirewall(server.Port(), server.HTTPPort())
			}
			report(server, phone, notes)
		}
	}
}

func sanitize(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r == '-' || r == '_' || r == ' ' || r == '.' || (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= 'а' && r <= 'я') || (r >= 'А' && r <= 'Я') || r == 'ё' || r == 'Ё' {
			b.WriteRune(r)
		}
	}
	text := strings.TrimSpace(b.String())
	if text == "" {
		return "Pult"
	}
	return text
}

func fingerprintShort(value string) string {
	compact := strings.ReplaceAll(value, ":", "")
	if len(compact) > 16 {
		return compact[:16]
	}
	return compact
}

func downloadDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		if current, lookErr := user.Current(); lookErr == nil {
			home = current.HomeDir
		}
	}
	if home == "" {
		home = "."
	}
	if profile := os.Getenv("USERPROFILE"); profile != "" {
		home = profile
	}
	return filepath.Join(home, "Downloads", "Pult")
}
