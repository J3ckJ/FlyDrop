package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/J3ckJ/FlyDrop/pult/web"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/agent"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/bootlog"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/cert"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/desktop"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/diag"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/mdns"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/paths"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/store"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/ui"
)

func runSelftest(dataFlag string) int {
	fmt.Println("Самопроверка Пульта. Окно закроется само, если запуск из общей консоли.")
	bootlog.Stage("самопроверка: каталог данных")
	dir, notes, err := paths.Choose(dataFlag)
	for _, note := range notes {
		bootlog.Printf("%s", note)
		fmt.Println(note)
	}
	if err != nil {
		return fail(err)
	}
	line(fmt.Sprintf("Самопроверка: данные %s", dir))
	bootlog.Stage("самопроверка: хранилище")
	phones, err := store.Open(dir)
	if err != nil {
		return fail(fmt.Errorf("Не удалось открыть список телефонов: %w", err))
	}
	bootlog.Stage("самопроверка: сертификат")
	material, err := cert.Load(dir, []string{"127.0.0.1"})
	if err != nil {
		return fail(fmt.Errorf("Не удалось записать сертификат в %s: %w", dir, err))
	}
	if len(material.Cert) == 0 || len(material.Key) == 0 || material.Fingerprint == "" {
		return fail(fmt.Errorf("Сертификат в %s пустой", dir))
	}
	line("Самопроверка: сертификат записан, отпечаток " + material.Fingerprint)
	bootlog.Stage("самопроверка: встроенные файлы")
	for _, name := range []string{"index.html", "setup.html", "app.js", "style.css"} {
		body, err := web.Files.ReadFile(name)
		if err != nil || len(body) == 0 {
			return fail(fmt.Errorf("В exe нет файла %s", name))
		}
	}
	line("Самопроверка: файлы интерфейса внутри exe на месте.")
	bootlog.Stage("самопроверка: привязка 4720 и 4721")
	server := agent.New(openDesktop(), phones)
	server.Name = "Pult"
	server.Addresses = []string{"127.0.0.1"}
	server.Downloads = dir
	server.HostID = phones.HostID()
	server.CA = material.CADer
	server.Fingerprint = material.Fingerprint
	serveErrors := startServer(server, material, 4720)
	defer server.Close()
	if err := waitListen(server, serveErrors); err != nil {
		return fail(err)
	}
	if server.Port() != 4720 || server.HTTPPort() != 4721 {
		return fail(fmt.Errorf("Открылись порты %d и %d, нужны 4720 и 4721", server.Port(), server.HTTPPort()))
	}
	line(fmt.Sprintf("Самопроверка: слушает %s и %s", server.Bound(), server.PlainBound()))
	if err := dialPort("127.0.0.1:4720"); err != nil {
		return fail(fmt.Errorf("HTTPS-порт не принимает соединение: %w", err))
	}
	if err := dialPort("127.0.0.1:4721"); err != nil {
		return fail(fmt.Errorf("HTTP-порт не принимает соединение: %w", err))
	}
	if err := diag.Probe("http://127.0.0.1:4721/ping"); err != nil {
		return fail(fmt.Errorf("http://127.0.0.1:4721/ping не ответил ok: %w", err))
	}
	line("Самопроверка: /ping ответил ok.")
	if err := readSetup(); err != nil {
		return fail(err)
	}
	line("Самопроверка: /setup открылся по HTTP.")
	bootlog.Stage("самопроверка: брандмауэр")
	for _, note := range applyFirewall(4720, 4721) {
		line("Самопроверка: брандмауэр: " + note)
	}
	bootlog.Stage("самопроверка: трей")
	presence, err := ui.Start()
	if err != nil {
		line("Самопроверка: трей пропущен: " + err.Error())
	} else {
		if err := ui.Pump(500 * time.Millisecond); err != nil {
			ui.Stop(presence)
			return fail(err)
		}
		ui.Stop(presence)
		line("Самопроверка: трей создан, очередь сообщений жива.")
	}
	bootlog.Stage("самопроверка: экран")
	line("Самопроверка: экран: " + desktop.ProbeCapture(server.Desktop))
	bootlog.Stage("самопроверка: mDNS")
	if err := mdns.Probe(); err != nil {
		line("Самопроверка: mDNS пропущен: " + err.Error())
	} else {
		line("Самопроверка: mDNS-сокет открылся.")
	}
	line("Самопроверка пройдена.")
	bootlog.Printf("PULT_SELFTEST_OK")
	return 0
}

func line(text string) {
	bootlog.Printf("%s", text)
	fmt.Println(text)
}

func dialPort(address string) error {
	conn, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		return err
	}
	return conn.Close()
}

func readSetup() error {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:4721/setup")
	if err != nil {
		return fmt.Errorf("http://127.0.0.1:4721/setup не открылся: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "4721") {
		return fmt.Errorf("http://127.0.0.1:4721/setup ответил %d", response.StatusCode)
	}
	return nil
}
