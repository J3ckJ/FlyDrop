package console

import "testing"

func TestShouldPauseOnlyForTheDoubleClickedWindow(t *testing.T) {
	t.Setenv("PULT_SELFTEST_NO_PAUSE", "0")
	if !ShouldPause(false, true) {
		t.Fatal("double-click should wait")
	}
	if ShouldPause(false, false) {
		t.Fatal("a shared console should not wait")
	}
	if !ShouldPause(true, true) {
		t.Fatal("self-test from a double-click should still wait")
	}
	t.Setenv("PULT_SELFTEST_NO_PAUSE", "1")
	if ShouldPause(true, true) {
		t.Fatal("the runner must not wait")
	}
	if !ShouldPause(false, true) {
		t.Fatal("the runner flag does not cover a normal launch")
	}
}
