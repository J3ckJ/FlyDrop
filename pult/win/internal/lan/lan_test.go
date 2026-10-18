package lan

import "testing"

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
