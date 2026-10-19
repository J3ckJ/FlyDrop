// Package console notices a double-clicked window and keeps it open.
package console

import (
	"bufio"
	"fmt"
	"os"
)

// ShouldPause reports whether this process should wait for Enter before it
// exits. A double-clicked console is the only process attached to its window.
// The self-test sets PULT_SELFTEST_NO_PAUSE so a runner cannot sit on Enter.
func ShouldPause(selftest, own bool) bool {
	if selftest && os.Getenv("PULT_SELFTEST_NO_PAUSE") == "1" {
		return false
	}
	return own
}

// Pause waits until the user presses Enter.
func Pause() {
	fmt.Println()
	fmt.Println("Нажмите Enter, чтобы закрыть это окно.")
	_, _ = bufio.NewReader(os.Stdin).ReadBytes('\n')
}
