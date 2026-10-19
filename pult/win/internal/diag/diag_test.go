package diag

import (
	"strings"
	"testing"
)

func TestExplainNamesBindProbeAndHotspot(t *testing.T) {
	text := strings.Join(Explain(Facts{
		BindHTTPS: "0.0.0.0:4720",
		BindHTTP:  "0.0.0.0:4721",
		Adapter:   "Wi-Fi",
		Address:   "192.168.1.24",
		HTTPPort:  4721,
		Notes:     []string{"Сеть сейчас общедоступная."},
		ProbeOK:   false,
		ProbeError: "connection refused",
	}), "\n")
	for _, part := range []string{"0.0.0.0:4720", "0.0.0.0:4721", "192.168.1.24", "connection refused", "Kaspersky", "изолирует клиентов", "Режим модема", "общедоступная"} {
		if !strings.Contains(text, part) {
			t.Fatalf("missing %q\n%s", part, text)
		}
	}
	if strings.Contains(text, "127.0.0.1:4720") {
		t.Fatal("loopback was offered as the phone address")
	}
}

func TestHotspotIsCalledOut(t *testing.T) {
	text := strings.Join(Explain(Facts{
		BindHTTPS: "0.0.0.0:4720",
		BindHTTP:  "0.0.0.0:4721",
		Address:   "172.20.10.4",
		Adapter:   "Wi-Fi",
		HTTPPort:  4721,
		ProbeOK:   true,
		Hotspot:   true,
	}), "\n")
	if !strings.Contains(text, "точки доступа iPhone") || !strings.Contains(text, ": ok") {
		t.Fatal(text)
	}
}
