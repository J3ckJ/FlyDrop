//go:build !windows

package main

import (
	"errors"

	"github.com/J3ckJ/FlyDrop/pult/win/internal/desktop"
)

func openDesktop() desktop.Desktop { return otherDesktop{} }

type otherDesktop struct{}

func (otherDesktop) Status() (desktop.Status, error) {
	return desktop.Status{Unavailable: true, Reason: "Эта сборка не для Windows. На компьютере запускайте pult.exe.", AppsRunning: []string{}}, nil
}

func (otherDesktop) Capture() ([]byte, int, int, error) {
	return nil, 0, 0, unavailable()
}
func (otherDesktop) Move(int, int) error          { return unavailable() }
func (otherDesktop) Click(string, int) error      { return unavailable() }
func (otherDesktop) Scroll(int, int) error        { return unavailable() }
func (otherDesktop) Key(string, bool) error       { return unavailable() }
func (otherDesktop) Text(string) error            { return unavailable() }
func (otherDesktop) Volume(*int, *bool) error     { return unavailable() }
func (otherDesktop) Media(string) error           { return unavailable() }
func (otherDesktop) Apps() ([]desktop.App, error) { return []desktop.App{}, nil }
func (otherDesktop) Launch(string) error          { return unavailable() }
func (otherDesktop) Clipboard() (string, error)   { return "", unavailable() }
func (otherDesktop) SetClipboard(string) error    { return unavailable() }
func (otherDesktop) Notifications() ([]desktop.Note, error) {
	return []desktop.Note{}, nil
}
func (otherDesktop) Power(string) error { return unavailable() }
func (otherDesktop) Close() error       { return nil }

func unavailable() error {
	return errors.New("Эта сборка не для Windows. На компьютере запускайте pult.exe.")
}
