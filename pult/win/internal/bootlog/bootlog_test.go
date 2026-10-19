package bootlog

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStageAndFailureLandInTheLog(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Pult", "pult.log")
	OpenFiles([]string{path, path})
	t.Cleanup(Close)
	Stage("сертификат")
	Fail(errors.New("порт не открылся"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{"этап: сертификат", "Пульт остановился.", "порт не открылся"} {
		if !strings.Contains(text, want) {
			t.Fatalf("log missing %q:\n%s", want, text)
		}
	}
	if got := Paths(); len(got) != 1 || got[0] != path {
		t.Fatalf("paths: %v", got)
	}
}

func TestPanicTextIncludesTheStack(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pult.log")
	OpenFiles([]string{path})
	t.Cleanup(Close)
	Panic("сбой трея")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "Пульт остановился из-за сбоя.") || !strings.Contains(text, "сбой трея") || !strings.Contains(text, "Стек:") {
		t.Fatalf("panic log: %s", text)
	}
}
