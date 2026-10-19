package agent

import (
	"net"
	"net/http"

	"github.com/J3ckJ/FlyDrop/pult/win/internal/cert"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/peer"
)

func (s *Server) servePlain(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if host == "" {
		host = r.RemoteAddr
	}
	if !peer.Allowed(host, true) {
		http.Error(w, "Только локальная сеть", http.StatusForbidden)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/ping":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	case r.Method == http.MethodGet && (r.URL.Path == "/setup" || r.URL.Path == "/setup.html" || r.URL.Path == "/style.css"):
		if !s.serveStatic(w, r) {
			http.NotFound(w, r)
		}
	case r.Method == http.MethodGet && r.URL.Path == "/ca.cer":
		w.Header().Set("Content-Type", "application/pkix-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="Pult.cer"`)
		_, _ = w.Write(s.CA)
	case r.Method == http.MethodGet && r.URL.Path == "/certificate.mobileconfig":
		w.Header().Set("Content-Type", "application/x-apple-aspen-config")
		w.Header().Set("Content-Disposition", `attachment; filename="Pult.mobileconfig"`)
		_, _ = w.Write([]byte(cert.MobileConfig(cert.Material{CADer: s.CA, Fingerprint: s.Fingerprint}, s.HostID)))
	case r.Method == http.MethodGet && r.URL.Path == "/":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!DOCTYPE html><meta charset=utf-8><title>Пульт</title><p>Сначала откройте <a href=\"/setup\">/setup</a> и установите профиль. Управление только по https, адрес напечатан в окне Пульта. <a href=\"/ping\">/ping</a> должен показать ok.</p>"))
	default:
		http.NotFound(w, r)
	}
}
