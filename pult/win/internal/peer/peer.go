// Package peer decides which TCP addresses may control the computer.
package peer

import "net"

// Allowed reports whether ip is a private IPv4 address, or loopback when that is enabled.
// Carrier-grade NAT (100.64/10) and public addresses are refused.
func Allowed(ip string, allowLoopback bool) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	if allowLoopback && parsed.IsLoopback() {
		return true
	}
	v4 := parsed.To4()
	if v4 == nil {
		return false
	}
	if v4[0] == 10 || (v4[0] == 192 && v4[1] == 168) || (v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) {
		return true
	}
	return v4[0] == 169 && v4[1] == 254
}
