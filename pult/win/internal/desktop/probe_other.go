//go:build !windows

package desktop

// ProbeCapture reports that this build has no Windows screen capture.
func ProbeCapture(Desktop) string {
	return "Снимок экрана пропущен: это не Windows."
}
