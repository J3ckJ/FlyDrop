// Package paths picks a directory the executable can write.
package paths

import (
	"fmt"
	"os"
	"path/filepath"
)

// Choose returns the first directory that accepts a file.
// An explicit directory is used as given. Otherwise the order is
// %APPDATA%\Pult, %LOCALAPPDATA%\Pult, then Pult-data next to the executable.
func Choose(explicit string) (string, []string, error) {
	if explicit != "" {
		if err := probe(explicit); err != nil {
			return "", nil, fmt.Errorf("Каталог данных недоступен (%s): %w", explicit, err)
		}
		return explicit, nil, nil
	}
	var candidates []string
	if appData := os.Getenv("APPDATA"); appData != "" {
		candidates = append(candidates, filepath.Join(appData, "Pult"))
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		candidates = append(candidates, filepath.Join(local, "Pult"))
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "Pult-data"))
	}
	if len(candidates) == 0 {
		candidates = append(candidates, "pult-data")
	}
	var notes []string
	var last error
	for _, dir := range candidates {
		if err := probe(dir); err != nil {
			last = err
			notes = append(notes, fmt.Sprintf("Каталог данных недоступен (%s): %v", dir, err))
			continue
		}
		return dir, notes, nil
	}
	if last == nil {
		last = fmt.Errorf("нет каталога для данных")
	}
	return "", notes, fmt.Errorf("Некуда сохранить сертификат и список телефонов: %w", last)
}

func probe(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	file := filepath.Join(dir, ".write-probe")
	if err := os.WriteFile(file, []byte("ok"), 0o600); err != nil {
		return err
	}
	return os.Remove(file)
}
