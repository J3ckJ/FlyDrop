package protocol

import "testing"

func TestShutdownRequiresHoldAndPairingCodeIsSixDigits(t *testing.T) {
	if _, err := Parse(`{"v":1,"id":"1","type":"power.action","payload":{"action":"shutdown"}}`); err == nil {
		t.Fatal("shutdown without hold was accepted")
	}
	message, err := Parse(`{"v":1,"id":"1","type":"pair","payload":{"code":"123456","name":"iPhone"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if message.Type != "pair" || message.Payload["code"] != "123456" {
		t.Fatalf("parsed %#v", message)
	}
}

func TestEveryCommandHasAValidator(t *testing.T) {
	for _, command := range ClientTypes {
		_, err := Parse(`{"v":1,"id":"1","type":"` + command + `","payload":{}}`)
		if err != nil && err.Error() == "Нет проверки для "+command {
			t.Fatalf("command %s has no validator", command)
		}
	}
}

func TestFrameRoundTripAndMagicPacket(t *testing.T) {
	frame, err := EncodeFrame([]byte{0xff, 0xd8, 0xff, 0xd9}, 7, 16, 9)
	if err != nil {
		t.Fatal(err)
	}
	seq, width, height, jpeg, err := DecodeFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 7 || width != 16 || height != 9 || len(jpeg) != 4 {
		t.Fatalf("frame meta %d %d %d %d", seq, width, height, len(jpeg))
	}
	packet, err := MagicPacket("B8:27:EB:00:00:01")
	if err != nil {
		t.Fatal(err)
	}
	if len(packet) != 102 || packet[0] != 0xff || packet[6] != 0xb8 || packet[7] != 0x27 {
		t.Fatalf("magic packet %d bytes, first mac %#x %#x", len(packet), packet[6], packet[7])
	}
}

func TestPublicAddressIsNotACommandProblem(t *testing.T) {
	if _, err := Parse(`{"v":2,"id":"1","type":"hello","payload":{}}`); err == nil {
		t.Fatal("version 2 accepted")
	}
}
