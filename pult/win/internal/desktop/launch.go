package desktop

import (
	"path/filepath"
	"strings"
)

func allowedLaunch(id string, roots []string) bool {
	if !strings.EqualFold(filepath.Ext(id), ".lnk") {
		return false
	}
	clean := filepath.Clean(id)
	for _, root := range roots {
		rel, err := filepath.Rel(root, clean)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
