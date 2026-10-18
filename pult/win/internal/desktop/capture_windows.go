//go:build windows

package desktop

import (
	"context"
	"time"

	"github.com/go-mswin/screencapture"
)

func (s *Session) captureFrame() ([]byte, int, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stream == nil {
		if err := s.openStream(); err != nil {
			return gdiJPEG()
		}
	}
	frame, fresh := s.stream.Frame()
	if fresh && frame.Valid() {
		return s.remember(frame)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	waited, err := s.stream.WaitFrame(ctx)
	if err == nil && waited.Valid() {
		return s.remember(waited)
	}
	if s.last != nil {
		return append([]byte(nil), s.last...), s.lastW, s.lastH, nil
	}
	return gdiJPEG()
}

func (s *Session) openStream() error {
	ctx, cancel := context.WithCancel(context.Background())
	displays, err := screencapture.Displays(ctx)
	if err != nil || len(displays) == 0 {
		cancel()
		if err == nil {
			err = errImage
		}
		return err
	}
	display := displays[0]
	for _, item := range displays {
		if item.Primary {
			display = item
			break
		}
	}
	stream, err := screencapture.CaptureDisplay(ctx, display, screencapture.Options{
		FPS:         12,
		ShowsCursor: false,
		Backend:     screencapture.BackendAuto,
	})
	if err != nil {
		cancel()
		return err
	}
	s.stream = stream
	s.stopCapture = cancel
	return nil
}

func (s *Session) remember(frame screencapture.Frame) ([]byte, int, int, error) {
	encoded, width, height, err := EncodeBGRA(frame.Pix, frame.Width, frame.Height, frame.Stride, 1280)
	if err != nil {
		return nil, 0, 0, err
	}
	s.last = append([]byte(nil), encoded...)
	s.lastW = width
	s.lastH = height
	return encoded, width, height, nil
}
