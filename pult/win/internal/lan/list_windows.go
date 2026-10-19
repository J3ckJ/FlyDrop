//go:build windows

package lan

import (
	"encoding/binary"
	"net"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Interfaces reads adapters and the IPv4 route table without starting a program.
func Interfaces() (phone []Adapter, skipped []Adapter, mac string, err error) {
	adapters, indexOf, err := adapters()
	if err != nil {
		return nil, nil, "", err
	}
	routes, err := defaultRoutes()
	if err != nil {
		routes = nil
	}
	phone, skipped = Phone(adapters, routes, indexOf)
	if len(phone) > 0 {
		mac = phone[0].MAC
	}
	return phone, skipped, mac, nil
}

func adapters() ([]Adapter, map[string]int, error) {
	var size uint32 = 15 * 1024
	var buf []byte
	for {
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_INET, windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST|windows.GAA_FLAG_SKIP_DNS_SERVER, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		if err == nil {
			break
		}
		if err != windows.ERROR_BUFFER_OVERFLOW {
			return nil, nil, err
		}
	}
	var list []Adapter
	indexOf := map[string]int{}
	for item := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); item != nil; item = item.Next {
		name := windows.UTF16PtrToString(item.FriendlyName)
		mac := formatMAC(item.PhysicalAddress[:item.PhysicalAddressLength])
		for unicast := item.FirstUnicastAddress; unicast != nil; unicast = unicast.Next {
			ip := unicast.Address.IP()
			parsed := ip.To4()
			if parsed == nil {
				continue
			}
			text := parsed.String()
			list = append(list, Adapter{Name: name, Address: text, MAC: mac})
			indexOf[text] = int(item.IfIndex)
		}
	}
	return list, indexOf, nil
}

func defaultRoutes() ([]Route, error) {
	proc := windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetIpForwardTable")
	var size uint32
	_, _, _ = proc.Call(0, uintptr(unsafe.Pointer(&size)), 1)
	if size < 4 {
		return nil, nil
	}
	buf := make([]byte, size)
	ret, _, callErr := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 1)
	if ret != 0 {
		if callErr != windows.ERROR_SUCCESS {
			return nil, callErr
		}
		return nil, nil
	}
	if int(size) < len(buf) {
		buf = buf[:size]
	}
	count := binary.LittleEndian.Uint32(buf[:4])
	const row = 56
	var routes []Route
	for i := uint32(0); i < count; i++ {
		off := 4 + int(i)*row
		if off+row > len(buf) {
			break
		}
		if binary.LittleEndian.Uint32(buf[off:off+4]) != 0 {
			continue
		}
		routes = append(routes, Route{
			IfIndex: int(binary.LittleEndian.Uint32(buf[off+16 : off+20])),
			Metric:  int(binary.LittleEndian.Uint32(buf[off+36 : off+40])),
		})
	}
	return routes, nil
}

func formatMAC(raw []byte) string {
	if len(raw) != 6 {
		return ""
	}
	return net.HardwareAddr(raw).String()
}
