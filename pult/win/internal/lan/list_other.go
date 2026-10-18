//go:build !windows

package lan

// Interfaces is empty outside Windows. The Node agent still chooses the address on macOS and Linux.
func Interfaces() (phone []Adapter, skipped []Adapter, mac string, err error) {
	return nil, nil, "", nil
}
