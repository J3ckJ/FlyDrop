package desktop

import (
	"path/filepath"
	"testing"
)

func TestOnlyStartMenuShortcutsLaunch(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "ProgramData", "Microsoft", "Windows", "Start Menu", "Programs")
	inside := filepath.Join(root, "Notepad.lnk")
	if !allowedLaunch(inside, []string{root}) {
		t.Fatal("a Start menu shortcut is allowed")
	}
	if allowedLaunch(filepath.Join(root, "notes.txt"), []string{root}) {
		t.Fatal("a text file is refused")
	}
	if allowedLaunch(filepath.Join(root, "..", "..", "notepad.lnk"), []string{root}) {
		t.Fatal("a path outside the Start menu is refused")
	}
	if allowedLaunch(`C:\Windows\System32\cmd.exe`, []string{root}) {
		t.Fatal("an executable path is refused")
	}
}
