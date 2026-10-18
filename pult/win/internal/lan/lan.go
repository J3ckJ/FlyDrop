package lan

import "regexp"

// Adapter is one IPv4 address the phone might use.
type Adapter struct {
	Name    string
	Address string
	MAC     string
}

// Route is one default route.
type Route struct {
	IfIndex int
	Address string
	Metric  int
}

var virtualName = regexp.MustCompile(`(?i)virtual|vethernet|hyper-?v|wsl|docker|virtualbox|vbox|vmware|vmnet|loopback|tap|tun|tunnel|vpn|tailscale|wireguard|hamachi|npcap|bluetooth|zerotier|nordlynx|cisco|anyconnect|fortinet|ppp|isatap|teredo|host-only|sangfor`)

// Phone returns the physical adapters, gateway first.
func Phone(adapters []Adapter, routes []Route, indexOf map[string]int) (phone []Adapter, skipped []Adapter) {
	for _, adapter := range adapters {
		if linkLocal(adapter.Address) {
			adapter.Name = adapter.Name
			skipped = append(skipped, adapter)
			continue
		}
		if virtualName.MatchString(adapter.Name) {
			skipped = append(skipped, adapter)
			continue
		}
		phone = append(phone, adapter)
	}
	if len(routes) == 0 || len(phone) < 2 {
		return phone, skipped
	}
	best := -1
	bestMetric := int(^uint(0) >> 1)
	for _, route := range routes {
		for i, adapter := range phone {
			if adapter.Address == route.Address || indexOf[adapter.Address] == route.IfIndex {
				if route.Metric < bestMetric {
					bestMetric = route.Metric
					best = i
				}
			}
		}
	}
	if best > 0 {
		reordered := make([]Adapter, 0, len(phone))
		reordered = append(reordered, phone[best])
		reordered = append(reordered, phone[:best]...)
		reordered = append(reordered, phone[best+1:]...)
		phone = reordered
	}
	return phone, skipped
}

func linkLocal(ip string) bool {
	return len(ip) >= 8 && ip[:8] == "169.254."
}
