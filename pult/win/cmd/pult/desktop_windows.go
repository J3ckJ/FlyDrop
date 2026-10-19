//go:build windows

package main

import "github.com/J3ckJ/FlyDrop/pult/win/internal/desktop"

func openDesktop() desktop.Desktop { return desktop.Open() }
