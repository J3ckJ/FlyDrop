// Package agent is the Windows release server: HTTPS, the PWA, and the Pult protocol.
package agent

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/J3ckJ/FlyDrop/pult/web"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/cert"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/desktop"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/peer"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/protocol"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/store"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/ws"
)

// Server speaks the same protocol as the Node agent.
type Server struct {
	Desktop     desktop.Desktop
	Store       *store.Store
	Name        string
	Addresses   []string
	Downloads   string
	MAC         string
	OnPresence  func(connected bool)
	Fingerprint string
	HostID      string
	CA          []byte

	mu       sync.Mutex
	code     string
	attempts map[string]attempt
	sessions map[*session]struct{}
	transfer transferState
	http     *http.Server
	listener net.Listener
	port     int
	cancel   context.CancelFunc
}

type attempt struct {
	count int
	until time.Time
}

type transferState struct {
	active bool
	name   string
	loaded int
	total  int
}

type session struct {
	conn      *ws.Conn
	peer      string
	paired    bool
	device    string
	stop      chan struct{}
	mu        sync.Mutex
	streaming bool
	screen    chan struct{}
	seq       uint64
}

// New builds a server. Call Serve to listen.
func New(desktopAPI desktop.Desktop, phones *store.Store) *Server {
	return &Server{
		Desktop:  desktopAPI,
		Store:    phones,
		Name:     "Pult",
		attempts: map[string]attempt{},
		sessions: map[*session]struct{}{},
		code:     newCode(),
	}
}

// Code is the current six-digit pairing code.
func (s *Server) Code() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.code
}

// Port is the bound TCP port.
func (s *Server) Port() int { return s.port }

// Serve listens until Close.
func (s *Server) Serve(material cert.Material, port int) error {
	certificate, err := tls.X509KeyPair(material.Cert, material.Key)
	if err != nil {
		return err
	}
	s.CA = material.CADer
	s.Fingerprint = material.Fingerprint
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	go s.schedules(ctx)
	listener, err := tls.Listen("tcp", fmt.Sprintf(":%d", port), &tls.Config{
		Certificates: []tls.Certificate{certificate},
		MinVersion:   tls.VersionTLS12,
	})
	if err != nil {
		return err
	}
	s.listener = listener
	s.port = listener.Addr().(*net.TCPAddr).Port
	s.http = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s.http.Serve(listener)
}

// Close stops the listener and the desktop.
func (s *Server) Close() error {
	if s.cancel != nil {
		s.cancel()
	}
	if s.http != nil {
		_ = s.http.Close()
	}
	if s.Desktop != nil {
		_ = s.Desktop.Close()
	}
	return nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if host == "" {
		host = r.RemoteAddr
	}
	if !peer.Allowed(host, true) {
		http.Error(w, "Только локальная сеть", http.StatusForbidden)
		return
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && r.URL.Path == "/pult" {
		s.upgrade(w, r, host)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if r.Method == http.MethodGet {
		if s.serveStatic(w, r) {
			return
		}
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/ca.cer":
		w.Header().Set("Content-Type", "application/pkix-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="Pult.cer"`)
		_, _ = w.Write(s.CA)
	case r.Method == http.MethodGet && r.URL.Path == "/certificate.mobileconfig":
		w.Header().Set("Content-Type", "application/x-apple-aspen-config")
		w.Header().Set("Content-Disposition", `attachment; filename="Pult.mobileconfig"`)
		_, _ = io.WriteString(w, cert.MobileConfig(cert.Material{CADer: s.CA, Fingerprint: s.Fingerprint}, s.HostID))
	case r.Method == http.MethodGet && r.URL.Path == "/api/push/key":
		writeJSON(w, http.StatusOK, map[string]string{"publicKey": ""})
	case r.Method == http.MethodPost && r.URL.Path == "/api/session":
		if err := sameOrigin(r); err != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
			return
		}
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Некорректный запрос"})
			return
		}
		device := s.Store.Find(body.Token)
		if device == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Сначала введите код с компьютера"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "__Host-pult-session", Value: body.Token, HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, Path: "/", MaxAge: 2592000})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": device.Name})
	case r.Method == http.MethodPost && r.URL.Path == "/api/upload":
		s.upload(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Не найдено"})
	}
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) bool {
	name := r.URL.Path
	if name == "/" {
		name = "/index.html"
	}
	name = path.Clean(name)
	if strings.Contains(name, "..") {
		return false
	}
	body, err := web.Files.ReadFile(strings.TrimPrefix(name, "/"))
	if err != nil {
		return false
	}
	kind := mime.TypeByExtension(path.Ext(name))
	if path.Ext(name) == ".webmanifest" {
		kind = "application/manifest+json"
	}
	if kind == "" {
		kind = "application/octet-stream"
	}
	if path.Ext(name) == ".js" || name == "/index.html" || name == "/setup.html" {
		kind += "; charset=utf-8"
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
	return true
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	if err := sameOrigin(r); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	if s.deviceFromCookie(r) == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Сначала сопряжение"})
		return
	}
	size, err := strconv.Atoi(r.Header.Get("Content-Length"))
	if err != nil || size < 0 {
		writeJSON(w, http.StatusLengthRequired, map[string]string{"error": "Неизвестен размер файла"})
		return
	}
	if size > protocol.MaxFileBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Файл превышает 1 ГБ"})
		return
	}
	name := fileName(r.Header.Get("X-Filename"))
	if err := os.MkdirAll(s.Downloads, 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Нет папки загрузок"})
		return
	}
	target := uniquePath(s.Downloads, name)
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Файл не записан"})
		return
	}
	defer file.Close()
	written, err := io.Copy(file, io.LimitReader(r.Body, int64(size)))
	if err != nil || written != int64(size) {
		_ = os.Remove(target)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Передача оборвалась"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"name": filepath.Base(target), "size": written})
}

func (s *Server) deviceFromCookie(r *http.Request) *store.Device {
	cookie, err := r.Cookie("__Host-pult-session")
	if err != nil {
		return nil
	}
	return s.Store.Find(cookie.Value)
}

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request, host string) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" || r.Header.Get("Sec-WebSocket-Version") != "13" {
		http.Error(w, "bad websocket", http.StatusBadRequest)
		return
	}
	hijack, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "no hijack", http.StatusInternalServerError)
		return
	}
	raw, _, err := hijack.Hijack()
	if err != nil {
		return
	}
	conn, err := ws.Handshake(raw, key)
	if err != nil {
		_ = raw.Close()
		return
	}
	current := &session{conn: conn, peer: host, stop: make(chan struct{})}
	s.mu.Lock()
	if len(s.sessions) >= 8 {
		s.mu.Unlock()
		conn.Close()
		return
	}
	s.sessions[current] = struct{}{}
	s.mu.Unlock()
	conn.OnText(func(frame []byte) { s.onText(current, frame) })
	conn.OnClose(func() { s.drop(current) })
	conn.ReadLoop()
}

func (s *Server) drop(current *session) {
	s.mu.Lock()
	delete(s.sessions, current)
	paired := s.pairedCount()
	s.mu.Unlock()
	select {
	case <-current.stop:
	default:
		close(current.stop)
	}
	if s.OnPresence != nil {
		s.OnPresence(paired > 0)
	}
}

func (s *Server) pairedCount() int {
	count := 0
	for item := range s.sessions {
		if item.paired {
			count++
		}
	}
	return count
}

func (s *Server) onText(current *session, frame []byte) {
	message, err := protocol.Parse(string(frame))
	if err != nil {
		s.reply(current, protocol.Message{}, err.Error())
		return
	}
	if !current.paired && message.Type != "hello" && message.Type != "pair" {
		s.reply(current, message, "Сначала сопряжение")
		return
	}
	payload, err := s.handle(current, message)
	if err != nil {
		s.reply(current, message, err.Error())
		return
	}
	raw, err := protocol.Result(message, payload)
	if err != nil {
		return
	}
	_ = current.conn.WriteText(raw)
}

func (s *Server) reply(current *session, message protocol.Message, text string) {
	raw, err := protocol.Failure(message, text)
	if err == nil {
		_ = current.conn.WriteText(raw)
	}
}

func (s *Server) handle(current *session, message protocol.Message) (any, error) {
	switch message.Type {
	case "hello":
		var device *store.Device
		if token, _ := message.Payload["token"].(string); token != "" {
			device = s.Store.Find(token)
			if device == nil {
				return nil, fmt.Errorf("Телефон не сопряжён")
			}
			current.paired = true
			current.device = device.ID
			_ = s.Store.Touch(device.ID)
			s.presence()
		}
		return s.publicInfo(current.paired), nil
	case "pair":
		code, _ := message.Payload["code"].(string)
		s.mu.Lock()
		matches := subtleCode(code, s.code)
		s.mu.Unlock()
		if !matches {
			if err := s.failLimit(current.peer); err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("Неверный код. Он показан на компьютере")
		}
		name, _ := message.Payload["name"].(string)
		token, device, err := s.Store.Remember(clean(name))
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.code = newCode()
		s.mu.Unlock()
		current.paired = true
		current.device = device.ID
		s.presence()
		info := s.publicInfo(true)
		info["token"] = token
		info["deviceId"] = device.ID
		return info, nil
	case "status.get":
		return s.status()
	case "screen.subscribe":
		fps := 12
		if value, ok := message.Payload["fps"].(float64); ok && value >= 1 {
			fps = int(value)
		}
		s.startScreen(current, fps)
		return map[string]any{"fps": fps}, nil
	case "screen.unsubscribe":
		s.stopScreen(current)
		return map[string]any{}, nil
	case "input.move":
		dx, _ := message.Payload["dx"].(float64)
		dy, _ := message.Payload["dy"].(float64)
		return map[string]any{}, s.Desktop.Move(int(dx), int(dy))
	case "input.click":
		button, _ := message.Payload["button"].(string)
		if button == "" {
			button = "left"
		}
		count := 1
		if value, ok := message.Payload["count"].(float64); ok && value >= 1 {
			count = int(value)
		}
		return map[string]any{}, s.Desktop.Click(button, count)
	case "input.scroll":
		dx, _ := message.Payload["dx"].(float64)
		dy, _ := message.Payload["dy"].(float64)
		return map[string]any{}, s.Desktop.Scroll(int(dx), int(dy))
	case "input.key":
		key, _ := message.Payload["key"].(string)
		down, _ := message.Payload["down"].(bool)
		return map[string]any{}, s.Desktop.Key(key, down)
	case "input.text":
		text, _ := message.Payload["text"].(string)
		return map[string]any{}, s.Desktop.Text(text)
	case "volume.set":
		var level *int
		var muted *bool
		if value, ok := message.Payload["level"].(float64); ok {
			number := int(value)
			level = &number
		}
		if value, ok := message.Payload["muted"].(bool); ok {
			muted = &value
		}
		return map[string]any{}, s.Desktop.Volume(level, muted)
	case "media.command":
		action, _ := message.Payload["action"].(string)
		return map[string]any{}, s.Desktop.Media(action)
	case "apps.list":
		apps, err := s.Desktop.Apps()
		if err != nil {
			return nil, err
		}
		return map[string]any{"apps": apps}, nil
	case "apps.launch":
		id, _ := message.Payload["id"].(string)
		if err := s.Desktop.Launch(id); err != nil {
			return nil, err
		}
		return map[string]any{"id": id, "running": true}, nil
	case "clipboard.get":
		text, err := s.Desktop.Clipboard()
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": text}, nil
	case "clipboard.set":
		text, _ := message.Payload["text"].(string)
		return map[string]any{}, s.Desktop.SetClipboard(text)
	case "notifications.list":
		items, err := s.Desktop.Notifications()
		if err != nil {
			return nil, err
		}
		return map[string]any{"items": items}, nil
	case "power.action":
		return s.power(message.Payload)
	case "wol.wake":
		mac, _ := message.Payload["mac"].(string)
		return map[string]any{"sent": true}, sendWake(mac)
	case "wol.schedule.list":
		return map[string]any{"schedules": s.Store.Schedules()}, nil
	case "wol.schedule.put":
		hour, _ := message.Payload["hour"].(float64)
		minute, _ := message.Payload["minute"].(float64)
		id, _ := message.Payload["id"].(string)
		label, _ := message.Payload["label"].(string)
		mac, _ := message.Payload["mac"].(string)
		item, err := s.Store.PutSchedule(store.Schedule{ID: id, MAC: strings.ToLower(mac), Label: label, Hour: int(hour), Minute: int(minute)})
		if err != nil {
			return nil, err
		}
		return map[string]any{"schedule": item}, nil
	case "wol.schedule.delete":
		id, _ := message.Payload["id"].(string)
		return map[string]any{}, s.Store.DeleteSchedule(id)
	case "flydrop.progress":
		s.noteTransfer(message.Payload)
		return map[string]any{"accepted": true}, nil
	case "flydrop.info":
		return s.publicInfo(true)["flydrop"], nil
	default:
		return nil, fmt.Errorf("Команда не обработана: %s", message.Type)
	}
}

func (s *Server) power(payload map[string]any) (any, error) {
	action, _ := payload["action"].(string)
	s.mu.Lock()
	active := s.transfer.active
	loaded, total, name := s.transfer.loaded, s.transfer.total, s.transfer.name
	s.mu.Unlock()
	force, _ := payload["force"].(bool)
	if (action == "shutdown" || action == "restart") && active && !force {
		percent := 0
		if total > 0 {
			percent = int(math.Round(float64(loaded) / float64(total) * 100))
		}
		return map[string]any{"performed": false, "warning": fmt.Sprintf("FlyDrop ещё идёт: %s %d%% — выключение подождёт", name, percent)}, nil
	}
	if err := s.Desktop.Power(action); err != nil {
		return nil, err
	}
	return map[string]any{"performed": true}, nil
}

func (s *Server) status() (map[string]any, error) {
	state, err := s.Desktop.Status()
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	s.mu.Lock()
	percent := 0
	if s.transfer.total > 0 {
		percent = int(math.Round(float64(s.transfer.loaded) / float64(s.transfer.total) * 100))
	}
	fly := map[string]any{"active": s.transfer.active, "name": s.transfer.name, "loaded": s.transfer.loaded, "total": s.transfer.total, "percent": percent}
	s.mu.Unlock()
	payload["name"] = s.Name
	payload["os"] = "windows"
	payload["mac"] = s.MAC
	payload["online"] = true
	payload["flydrop"] = fly
	return payload, nil
}

func (s *Server) publicInfo(paired bool) map[string]any {
	return map[string]any{
		"name": s.Name, "os": "windows", "protocol": protocol.Version, "paired": paired,
		"fingerprint": s.Fingerprint, "mac": s.MAC, "demo": false,
		"flydrop": map[string]any{"external": false, "httpPort": 0, "httpsPort": s.port, "fingerprint": s.Fingerprint},
	}
}

func (s *Server) startScreen(current *session, fps int) {
	s.stopScreen(current)
	stop := make(chan struct{})
	current.mu.Lock()
	current.screen = stop
	current.streaming = true
	current.mu.Unlock()
	interval := time.Second / time.Duration(fps)
	if interval <= 0 {
		interval = time.Second / 12
	}
	go func() {
		if !s.emitFrame(current) {
			return
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-current.stop:
				return
			case <-stop:
				return
			case <-ticker.C:
				if !s.emitFrame(current) {
					return
				}
			}
		}
	}()
}

func (s *Server) emitFrame(current *session) bool {
	current.mu.Lock()
	on := current.streaming
	current.mu.Unlock()
	if !on {
		return false
	}
	jpeg, width, height, err := s.Desktop.Capture()
	if err != nil {
		raw, _ := protocol.Event("event.screen", map[string]any{"error": err.Error(), "unavailable": true})
		_ = current.conn.WriteText(raw)
		current.mu.Lock()
		current.streaming = false
		current.mu.Unlock()
		return false
	}
	if len(jpeg) == 0 || len(jpeg) > protocol.MaxFrameBytes {
		return true
	}
	current.mu.Lock()
	current.seq++
	seq := current.seq
	current.mu.Unlock()
	frame, err := protocol.EncodeFrame(jpeg, seq, width, height)
	if err == nil {
		_ = current.conn.WriteBinary(frame)
	}
	return true
}

func (s *Server) stopScreen(current *session) {
	current.mu.Lock()
	defer current.mu.Unlock()
	current.streaming = false
	if current.screen != nil {
		close(current.screen)
		current.screen = nil
	}
}

func (s *Server) schedules(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.fireSchedules(now)
		}
	}
}

func (s *Server) fireSchedules(now time.Time) {
	date := fmt.Sprintf("%d-%d-%d", now.Year(), int(now.Month()), now.Day())
	for _, item := range s.Store.Schedules() {
		if item.Hour != now.Hour() || item.Minute != now.Minute() || item.LastFiredDate == date {
			continue
		}
		if err := sendWake(item.MAC); err != nil {
			continue
		}
		_ = s.Store.MarkSchedule(item.ID, date)
	}
}

func (s *Server) noteTransfer(payload map[string]any) {
	state, _ := payload["state"].(string)
	name, _ := payload["name"].(string)
	loaded, _ := payload["loaded"].(float64)
	total, _ := payload["total"].(float64)
	s.mu.Lock()
	s.transfer = transferState{active: state == "uploading", name: name, loaded: int(loaded), total: int(total)}
	s.mu.Unlock()
}

func (s *Server) presence() {
	s.mu.Lock()
	count := s.pairedCount()
	s.mu.Unlock()
	if s.OnPresence != nil {
		s.OnPresence(count > 0)
	}
}

func (s *Server) failLimit(ip string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	slot := s.attempts[ip]
	if time.Now().After(slot.until) {
		slot = attempt{until: time.Now().Add(time.Minute)}
	}
	if slot.count >= protocol.PairingAttempts {
		return fmt.Errorf("Слишком много попыток. Подождите минуту")
	}
	slot.count++
	s.attempts[ip] = slot
	return nil
}

func sameOrigin(r *http.Request) error {
	origin := "https://" + r.Host
	if r.Header.Get("Origin") != origin {
		return fmt.Errorf("Требуется приложение Пульт")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func fileName(header string) string {
	name := header
	if decoded, err := urlPath(header); err == nil {
		name = decoded
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	clean := make([]rune, 0, len(name))
	for _, r := range name {
		if r < 32 || r == '/' || r == '\\' {
			clean = append(clean, '_')
			continue
		}
		clean = append(clean, r)
	}
	if len(clean) == 0 {
		return "file"
	}
	if len(clean) > 180 {
		clean = clean[len(clean)-180:]
	}
	return string(clean)
}

func urlPath(value string) (string, error) {
	return url.PathUnescape(value)
}

func uniquePath(dir, name string) string {
	target := filepath.Join(dir, name)
	if _, err := os.Stat(target); err != nil {
		return target
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; i < 1000; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
		if _, err := os.Stat(candidate); err != nil {
			return candidate
		}
	}
	return target
}

func clean(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 40 {
		runes = runes[:40]
	}
	return string(runes)
}

func subtleCode(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	diff := 0
	for i := 0; i < len(left); i++ {
		diff |= int(left[i] ^ right[i])
	}
	return diff == 0
}

func newCode() string {
	var buf [4]byte
	_, _ = io.ReadFull(randReader{}, buf[:])
	n := int(buf[0])<<16 | int(buf[1])<<8 | int(buf[2])
	return fmt.Sprintf("%06d", 100000+(n%900000))
}

type randReader struct{}

func (randReader) Read(p []byte) (int, error) { return rand.Read(p) }

func sendWake(mac string) error {
	packet, err := protocol.MagicPacket(mac)
	if err != nil {
		return err
	}
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4bcast, Port: 9})
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write(packet)
	return err
}
