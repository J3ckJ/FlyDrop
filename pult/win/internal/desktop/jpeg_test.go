package desktop

import (
	"bytes"
	"image/jpeg"
	"testing"
)

func TestEncodeBGRAMakesAJPEGAndScales(t *testing.T) {
	const width, height = 8, 4
	pix := make([]byte, width*4*height)
	for i := 0; i < len(pix); i += 4 {
		pix[i] = 20
		pix[i+1] = 40
		pix[i+2] = 200
		pix[i+3] = 0
	}
	encoded, outW, outH, err := EncodeBGRA(pix, width, height, width*4, 4)
	if err != nil {
		t.Fatal(err)
	}
	if outW != 4 || outH != 2 {
		t.Fatalf("scaled to %dx%d", outW, outH)
	}
	img, err := jpeg.Decode(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 4 {
		t.Fatalf("decoded width %d", img.Bounds().Dx())
	}
}
