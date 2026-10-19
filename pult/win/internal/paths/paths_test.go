package paths

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChooseUsesAnExplicitDirectory(t *testing.T) {
	dir := t.TempDir()
	got, notes, err := Choose(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != dir || len(notes) != 0 {
		t.Fatalf("got %s notes %v", got, notes)
	}
}

func TestChooseRejectsAFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Choose(file); err == nil {
		t.Fatal("expected an error")
	}
}
