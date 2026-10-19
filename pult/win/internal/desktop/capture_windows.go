//go:build windows

package desktop

import (
	"context"
	"fmt"
	"time"

	"github.com/go-mswin/screencapture"
)

// ProbeCapture opens a capture stream and closes it. DXGI stays unused until a
// phone asks for a frame; this probe exists for the startup self-test. A
// failure is a status line, not a reason to exit.
func ProbeCapture(d Desktop) string {
	session, ok := d.(*Session)
	if !ok || session == nil {
		return "Снимок экрана пропущен: это не сессия Windows."
	}
	ch := make(chan string, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				ch <- fmt.Sprintf("Снимок экрана вызвал сбой и пропущен: %v", recovered)
			}
		}()
		ch <- probeOnce()
	}()
	select {
	case line := <-ch:
		return line
	case <-time.After(12 * time.Second):
		return "Снимок экрана не ответил за 12 с и пропущен. При обычном запуске DXGI не открывается, пока телефон не запросит кадр."
	}
}

func probeOnce() string {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	displays, err := screencapture.Displays(ctx)
	if err == nil && len(displays) > 0 {
		display := displays[0]
		for _, item := range displays {
			if item.Primary {
				display = item
				break
			}
		}
		stream, openErr := screencapture.CaptureDisplay(ctx, display, screencapture.Options{
			FPS:         12,
			ShowsCursor: false,
			Backend:     screencapture.BackendAuto,
		})
		if openErr == nil && stream != nil {
			_ = stream.Close()
			return "Поток захвата открылся и сразу закрыт. При обычном запуске DXGI ждёт первый кадр с телефона."
		}
		err = openErr
	}
	if jpeg, _, _, gerr := gdiJPEG(); gerr == nil && len(jpeg) > 0 {
		if err == nil {
			err = errImage
		}
		return fmt.Sprintf("DXGI пропущен (%v). GDI ответил, кадр %d байт. Захват при старте не держится открытым.", err, len(jpeg))
	}
	if err == nil {
		err = errImage
	}
	return fmt.Sprintf("Экран сейчас недоступен, запуск это не останавливает. DXGI: %v", err)
}

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
