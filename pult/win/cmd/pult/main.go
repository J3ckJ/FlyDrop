package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	qrterminal "github.com/mdp/qrterminal/v3"

	"github.com/J3ckJ/FlyDrop/pult/win/internal/agent"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/cert"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/diag"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/firewall"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/lan"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/mdns"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/store"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/ui"
)

func main() {
	portFlag := flag.Int("port", 4720, "порт HTTPS")
	nameFlag := flag.String("name", "", "имя компьютера")
	dataFlag := flag.String("data", "", "каталог данных")
	noFirewall := flag.Bool("no-firewall", false, "не менять брандмауэр")
	noMDNS := flag.Bool("no-mdns", false, "не объявлять компьютер в локальной сети")
	revoke := flag.String("revoke", "", "снять сопряжение телефона")
	flag.Parse()

	dir := *dataFlag
	if dir == "" {
		dir = dataDir()
	}
	phones, err := store.Open(dir)
	if err != nil {
		exit(err)
	}
	if *revoke != "" {
		removed, err := phones.Revoke(*revoke)
		if err != nil {
			exit(err)
		}
		if removed {
			fmt.Println("Телефон удалён из сопряжённых.")
		} else {
			fmt.Println("Такого телефона нет.")
		}
		return
	}
	name := strings.TrimSpace(*nameFlag)
	if name == "" {
		name, _ = os.Hostname()
	}
	if name == "" {
		name = "Pult"
	}
	phone, skipped, mac, err := lan.Interfaces()
	if err != nil {
		fmt.Println("  Список адаптеров недоступен:", err)
	}
	addresses := []string{"127.0.0.1"}
	for _, adapter := range phone {
		addresses = append(addresses, adapter.Address)
	}
	material, err := cert.Load(dir, addresses)
	if err != nil {
		exit(err)
	}
	downloads := downloadDir()
	server := agent.New(openDesktop(), phones)
	server.Name = name
	server.Addresses = addresses
	server.Downloads = downloads
	server.MAC = mac
	server.HostID = phones.HostID()
	server.CA = material.CADer
	server.Fingerprint = material.Fingerprint
	presence := ui.Start()
	server.OnPresence = func(connected bool) { presence.Set(connected) }
	errors := make(chan error, 1)
	go func() { errors <- server.Serve(material, *portFlag) }()
	deadline := time.Now().Add(5 * time.Second)
	for server.Port() == 0 && time.Now().Before(deadline) {
		select {
		case err := <-errors:
			exit(err)
		default:
			time.Sleep(20 * time.Millisecond)
		}
	}
	if server.Port() == 0 || server.HTTPPort() == 0 {
		exit(fmt.Errorf("Порт не открылся"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	printConsole(server, phone, skipped, material.Fingerprint)
	notes := []string{"Проверка брандмауэра выключена (--no-firewall)."}
	if !*noFirewall {
		_, notes = firewall.Apply(server.Port(), server.HTTPPort())
	}
	report(server, phone, notes)
	go watchNetwork(ctx, server, *noFirewall)
	if !*noMDNS && len(phone) > 0 {
		addresses := make([]string, 0, len(phone))
		for _, adapter := range phone {
			addresses = append(addresses, adapter.Address)
		}
		host := phones.HostID()
		if len(host) > 8 {
			host = host[:8]
		}
		packet, err := mdns.BuildAnnouncement(sanitize(name), host+".local", server.Port(), addresses, map[string]string{
			"os": "windows", "ver": "1", "fp": fingerprintShort(material.Fingerprint), "fly": fmt.Sprint(server.Port()),
		})
		if err == nil {
			go mdns.Advertise(ctx, packet)
		}
	}
	fmt.Println("  Телефон вводит этот код. Без кода управление недоступно.")
	fmt.Println("  Телефон и компьютер — в одной Wi-Fi.")
	fmt.Println("  Закройте это окно или нажмите Ctrl+C, чтобы завершить Пульт.")
	fmt.Println()
	ui.Run(func() {
		cancel()
		_ = server.Close()
	})
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
	}
}

func watchNetwork(ctx context.Context, server *agent.Server, skipFirewall bool) {
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
				_, notes = firewall.Apply(server.Port(), server.HTTPPort())
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

func dataDir() string {
	if appData := os.Getenv("APPDATA"); appData != "" {
		return filepath.Join(appData, "Pult")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", "pult")
	}
	return "pult-data"
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

func exit(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
