// Package mdns announces _pult._tcp.local. The packet layout matches the Node agent.
package mdns

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

const service = "_pult._tcp.local"

// BuildAnnouncement returns one mDNS response for every address.
func BuildAnnouncement(instance, host string, port int, addresses []string, txt map[string]string) ([]byte, error) {
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("Некорректный порт")
	}
	instanceName := strings.TrimSpace(instance) + "." + service
	var answers []byte
	count := 0
	for _, address := range addresses {
		ip := net.ParseIP(address).To4()
		if ip == nil {
			continue
		}
		target, err := encodeName(instanceName)
		if err != nil {
			return nil, err
		}
		ptr, err := record(service, 12, target)
		if err != nil {
			return nil, err
		}
		serviceData, err := srvData(port, host)
		if err != nil {
			return nil, err
		}
		srv, err := record(instanceName, 33, serviceData)
		if err != nil {
			return nil, err
		}
		textData, err := txtData(txt)
		if err != nil {
			return nil, err
		}
		text, err := record(instanceName, 16, textData)
		if err != nil {
			return nil, err
		}
		a, err := record(host, 1, ip)
		if err != nil {
			return nil, err
		}
		answers = append(answers, ptr...)
		answers = append(answers, srv...)
		answers = append(answers, text...)
		answers = append(answers, a...)
		count += 4
	}
	if count == 0 {
		return nil, fmt.Errorf("Нет адреса для объявления")
	}
	header := make([]byte, 12)
	binary.BigEndian.PutUint16(header[2:], 0x8400)
	binary.BigEndian.PutUint16(header[6:], uint16(count))
	return append(header, answers...), nil
}

// Advertise repeats the packet until ctx ends. A failure to bind is not fatal for the phone,
// which can still type the address printed in the console.
func Advertise(ctx context.Context, packet []byte) {
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintf(os.Stderr, "Объявление в локальной сети остановилось: %v\n", recovered)
		}
	}()
	if len(packet) == 0 {
		return
	}
	conn, err := net.ListenMulticastUDP("udp4", nil, &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353})
	if err != nil {
		conn2, err2 := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353})
		if err2 != nil {
			return
		}
		defer conn2.Close()
		ticker := time.NewTicker(8 * time.Second)
		defer ticker.Stop()
		_ = conn2.SetWriteDeadline(time.Now().Add(time.Second))
		_, _ = conn2.Write(packet)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = conn2.SetWriteDeadline(time.Now().Add(time.Second))
				_, _ = conn2.Write(packet)
			}
		}
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
	_, _ = conn.WriteToUDP(packet, &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353})
	ticker := time.NewTicker(8 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
			_, _ = conn.WriteToUDP(packet, &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353})
		}
	}
}

// Probe tries the mDNS socket and closes it. A failure is not fatal:
// corporate Wi-Fi often blocks multicast, and the phone can type the address.
func Probe() error {
	target := &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353}
	conn, err := net.ListenMulticastUDP("udp4", nil, target)
	if err == nil {
		return conn.Close()
	}
	dialed, dialErr := net.DialUDP("udp4", nil, target)
	if dialErr == nil {
		_ = dialed.Close()
		return fmt.Errorf("Multicast mDNS не открылся (%v). Исходящий UDP к 224.0.0.251:5353 доступен. Изоляция Wi-Fi и сетевой экран входящие этим не открывают.", err)
	}
	return fmt.Errorf("Объявление mDNS недоступно (%v; %v). iPhone открывает адрес из консоли вручную.", err, dialErr)
}

func record(name string, kind uint16, data []byte) ([]byte, error) {
	encoded, err := encodeName(name)
	if err != nil {
		return nil, err
	}
	suffix := make([]byte, 10)
	binary.BigEndian.PutUint16(suffix[0:], kind)
	binary.BigEndian.PutUint16(suffix[2:], 0x8001)
	binary.BigEndian.PutUint32(suffix[4:], 120)
	binary.BigEndian.PutUint16(suffix[8:], uint16(len(data)))
	return append(append(encoded, suffix...), data...), nil
}

func encodeName(name string) ([]byte, error) {
	var out []byte
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if !utf8.ValidString(label) || len(label) == 0 || len(label) > 63 {
			return nil, fmt.Errorf("Некорректное имя mDNS")
		}
		out = append(out, byte(len(label)))
		out = append(out, label...)
	}
	return append(out, 0), nil
}

func srvData(port int, host string) ([]byte, error) {
	target, err := encodeName(host)
	if err != nil {
		return nil, err
	}
	head := make([]byte, 6)
	binary.BigEndian.PutUint16(head[4:], uint16(port))
	return append(head, target...), nil
}

func txtData(entries map[string]string) ([]byte, error) {
	var out []byte
	for _, key := range []string{"os", "ver", "fp", "fly"} {
		value, ok := entries[key]
		if !ok {
			continue
		}
		text := key + "=" + value
		if len(text) > 255 {
			return nil, fmt.Errorf("Слишком длинная TXT-запись")
		}
		out = append(out, byte(len(text)))
		out = append(out, text...)
	}
	if len(out) == 0 {
		return []byte{0}, nil
	}
	return out, nil
}
