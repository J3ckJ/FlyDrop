// Package bootlog writes startup stages and failures to disk before the console can close.
package bootlog

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

var (
	mu    sync.Mutex
	files []*os.File
	paths []string
)

// Open opens %LOCALAPPDATA%\Pult\pult.log and, when that directory is missing,
// the user cache. It also opens pult.log next to the executable when that
// directory accepts a file.
func Open() {
	var list []string
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		list = append(list, filepath.Join(local, "Pult", "pult.log"))
	} else if cache, err := os.UserCacheDir(); err == nil {
		list = append(list, filepath.Join(cache, "Pult", "pult.log"))
	}
	if exe, err := os.Executable(); err == nil {
		list = append(list, filepath.Join(filepath.Dir(exe), "pult.log"))
	}
	OpenFiles(list)
	exe, _ := os.Executable()
	Printf("файл: %s", exe)
}

// OpenFiles replaces the current logs. Tests use it with a temporary directory.
func OpenFiles(list []string) {
	mu.Lock()
	defer mu.Unlock()
	closeLocked()
	seen := map[string]bool{}
	for _, path := range list {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			continue
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			continue
		}
		files = append(files, file)
		paths = append(paths, path)
	}
	writeLocked(fmt.Sprintf("—— старт %s ——", time.Now().Format(time.RFC3339)))
}

// Paths returns the logs that were opened.
func Paths() []string {
	mu.Lock()
	defer mu.Unlock()
	out := make([]string, len(paths))
	copy(out, paths)
	return out
}

// Stage records one startup step.
func Stage(name string) {
	Printf("этап: %s", name)
}

// Printf appends one line to every open log and flushes it.
func Printf(format string, args ...any) {
	mu.Lock()
	defer mu.Unlock()
	writeLocked(fmt.Sprintf(format, args...))
}

// Fail prints a Russian error to the console and to the logs.
func Fail(err error) {
	text := fmt.Sprintf("Пульт остановился.\n%v", err)
	writeBoth(text)
}

// Panic prints a Russian failure and the stack to the console and to the logs.
func Panic(recovered any) {
	text := fmt.Sprintf("Пульт остановился из-за сбоя.\n%v\nСтек:\n%s", recovered, debug.Stack())
	writeBoth(text)
}

// Close flushes and closes the logs.
func Close() {
	mu.Lock()
	defer mu.Unlock()
	writeLocked("—— стоп ——")
	closeLocked()
}

func writeBoth(text string) {
	mu.Lock()
	where := append([]string(nil), paths...)
	writeLocked(text)
	mu.Unlock()
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "════════════════════════════════════════")
	fmt.Fprintln(os.Stderr, text)
	if len(where) > 0 {
		fmt.Fprintf(os.Stderr, "Журнал: %s\n", strings.Join(where, " и "))
	} else {
		fmt.Fprintln(os.Stderr, "Журнал на диск не записался. Текст выше — единственная копия.")
	}
	fmt.Fprintln(os.Stderr, "════════════════════════════════════════")
}

func writeLocked(text string) {
	line := time.Now().Format("15:04:05") + " " + strings.TrimRight(text, "\n") + "\n"
	for _, file := range files {
		_, _ = file.WriteString(line)
		_ = file.Sync()
	}
}

func closeLocked() {
	for _, file := range files {
		_ = file.Close()
	}
	files = nil
	paths = nil
}
