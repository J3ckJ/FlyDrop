package desktop

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
)

// EncodeBGRA turns a top-down BGRA buffer into a JPEG no wider than maxWidth.
// Alpha from GDI is ignored: a zero alpha channel would otherwise encode as black.
func EncodeBGRA(pix []byte, width, height, stride, maxWidth int) ([]byte, int, int, error) {
	if width < 1 || height < 1 || stride < width*4 || len(pix) < stride*height {
		return nil, 0, 0, errImage
	}
	src := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		row := pix[y*stride : y*stride+width*4]
		for x := 0; x < width; x++ {
			src.SetRGBA(x, y, color.RGBA{R: row[x*4+2], G: row[x*4+1], B: row[x*4], A: 255})
		}
	}
	outW, outH := width, height
	picture := image.Image(src)
	if maxWidth > 0 && width > maxWidth {
		outW = maxWidth
		outH = height * maxWidth / width
		if outH < 1 {
			outH = 1
		}
		scaled := image.NewRGBA(image.Rect(0, 0, outW, outH))
		for y := 0; y < outH; y++ {
			sy := y * height / outH
			for x := 0; x < outW; x++ {
				scaled.SetRGBA(x, y, src.RGBAAt(x*width/outW, sy))
			}
		}
		picture = scaled
	}
	quality := 45
	var last []byte
	for quality >= 15 {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, picture, &jpeg.Options{Quality: quality}); err != nil {
			return nil, 0, 0, err
		}
		last = buf.Bytes()
		if len(last) <= 1024*1024 {
			return last, outW, outH, nil
		}
		quality -= 10
	}
	return last, outW, outH, nil
}

var errImage = imageError("Некорректный кадр")

type imageError string

func (e imageError) Error() string { return string(e) }
