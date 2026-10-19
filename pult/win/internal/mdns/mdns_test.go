package mdns

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestAnnouncementMatchesTheNodeLayout(t *testing.T) {
	packet, err := BuildAnnouncement("armg-933", "abcd1234.local", 4720, []string{"192.168.1.24"}, map[string]string{
		"os": "windows", "ver": "1", "fp": "AABBCCDDEEFF0011", "fly": "4720",
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.BigEndian.Uint16(packet[2:4]) != 0x8400 {
		t.Fatalf("flags %x", packet[2:4])
	}
	if binary.BigEndian.Uint16(packet[6:8]) != 4 {
		t.Fatalf("answers %d", binary.BigEndian.Uint16(packet[6:8]))
	}
	text := string(packet)
	if !strings.Contains(text, "_pult") || !strings.Contains(text, "armg-933") || !strings.Contains(text, "os=windows") {
		t.Fatal("packet is missing the service")
	}
	if _, err := BuildAnnouncement("Pult", "host.local", 4720, nil, nil); err == nil {
		t.Fatal("an announcement needs an address")
	}
}
