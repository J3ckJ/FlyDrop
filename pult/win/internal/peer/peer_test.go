package peer

import "testing"

func TestPublicAndCarrierGradeAreRefused(t *testing.T) {
	if Allowed("8.8.8.8", true) || Allowed("100.64.0.1", true) {
		t.Fatal("public or CGNAT address was allowed")
	}
	if !Allowed("192.168.1.24", false) || !Allowed("127.0.0.1", true) {
		t.Fatal("local address was refused")
	}
	if Allowed("127.0.0.1", false) {
		t.Fatal("loopback allowed when disabled")
	}
}
