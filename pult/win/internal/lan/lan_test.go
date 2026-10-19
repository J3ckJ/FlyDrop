package lan

import "testing"

func TestHotspotBeatsTheOfficeGateway(t *testing.T) {
	phone, _ := Phone([]Adapter{
		{Name: "Wi-Fi", Address: "10.1.2.3"},
		{Name: "Wi-Fi 2", Address: "172.20.10.4"},
	}, []Route{
		{Address: "10.1.2.3", Metric: 10},
		{Address: "172.20.10.4", Metric: 50},
	}, nil)
	if phone[0].Address != "172.20.10.4" {
		t.Fatalf("hotspot was not first: %+v", phone)
	}
	if !IsHotspot("172.20.10.2") || IsHotspot("172.20.10.20") || IsHotspot("10.0.0.1") {
		t.Fatal("hotspot range")
	}
}

func TestGatewayAdapterComesFirst(t *testing.T) {
	phone, skipped := Phone([]Adapter{
		{Name: "vEthernet (WSL)", Address: "172.19.224.1"},
		{Name: "Ethernet 2", Address: "169.254.64.40"},
		{Name: "Wi-Fi", Address: "192.168.1.24", MAC: "b8:27:eb:00:00:02"},
		{Name: "Ethernet", Address: "10.0.0.5", MAC: "aa:bb:cc:dd:ee:ff"},
	}, []Route{
		{IfIndex: 4, Address: "192.168.1.24", Metric: 40},
		{IfIndex: 9, Address: "10.0.0.5", Metric: 10},
	}, map[string]int{"192.168.1.24": 4, "10.0.0.5": 9})
	if len(phone) != 2 || phone[0].Address != "10.0.0.5" || phone[1].Address != "192.168.1.24" {
		t.Fatalf("order %+v", phone)
	}
	if len(skipped) != 2 {
		t.Fatalf("skipped %+v", skipped)
	}
}
