package trust

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWindowsSourcesDoNotNameAScriptHost(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("no caller")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", ".."))
	banned := []string{"powershell", "cmd.exe", "rundll32", "wscript", "cscript", "mshta", "netsh", "os/exec", "child_process"}
	var checked int
	err := filepath.WalkDir(filepath.Join(root, "pult", "win"), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		checked++
		text := strings.ToLower(string(body))
		for _, word := range banned {
			if strings.Contains(text, word) {
				t.Errorf("%s contains %s", path, word)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 8 {
		t.Fatalf("expected the Windows sources, checked %d", checked)
	}
}
