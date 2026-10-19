package agent

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/J3ckJ/FlyDrop/pult/win/internal/cert"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/desktop"
	"github.com/J3ckJ/FlyDrop/pult/win/internal/store"
)

type fakeDesktop struct {
	mu    sync.Mutex
	moves int
	power []string
	clip  string
}

func (f *fakeDesktop) Status() (desktop.Status, error) {
	level := 40
	return desktop.Status{Volume: &level, AppsRunning: []string{}, Media: nil}, nil
}
func (f *fakeDesktop) Capture() ([]byte, int, int, error) {
	return []byte{0xff, 0xd8, 0xff, 0xd9}, 8, 4, nil
}
func (f *fakeDesktop) Move(dx, dy int) error {
	f.mu.Lock()
	f.moves += dx + dy
	f.mu.Unlock()
	return nil
}
func (f *fakeDesktop) Click(string, int) error  { return nil }
func (f *fakeDesktop) Scroll(int, int) error    { return nil }
func (f *fakeDesktop) Key(string, bool) error   { return nil }
func (f *fakeDesktop) Text(string) error        { return nil }
func (f *fakeDesktop) Volume(*int, *bool) error { return nil }
func (f *fakeDesktop) Media(string) error       { return nil }
func (f *fakeDesktop) Apps() ([]desktop.App, error) {
	return []desktop.App{{ID: "notepad", Name: "Блокнот"}}, nil
}
func (f *fakeDesktop) Launch(string) error { return nil }
func (f *fakeDesktop) Clipboard() (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clip, nil
}
func (f *fakeDesktop) SetClipboard(text string) error {
	f.mu.Lock()
	f.clip = text
	f.mu.Unlock()
	return nil
}
func (f *fakeDesktop) Notifications() ([]desktop.Note, error) { return []desktop.Note{}, nil }
func (f *fakeDesktop) Power(action string) error {
	f.mu.Lock()
	f.power = append(f.power, action)
	f.mu.Unlock()
	return nil
}
func (f *fakeDesktop) Close() error { return nil }

func TestPairStatusMovePowerAndUpload(t *testing.T) {
	dir := t.TempDir()
	phones, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	material, err := cert.Load(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	desk := &fakeDesktop{}
	server := New(desk, phones)
	server.Name = "armg-933"
	server.Downloads = filepath.Join(dir, "in")
	server.MAC = "aa:bb:cc:dd:ee:ff"
	server.HostID = phones.HostID()
	go func() { _ = server.Serve(material, 0) }()
	t.Cleanup(func() { _ = server.Close() })
	deadline := time.Now().Add(3 * time.Second)
	for server.Port() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if server.Port() == 0 {
		t.Fatal("server did not listen")
	}
	conn := dialPult(t, server.Port())
	defer conn.Close()
	code := server.Code()
	reply := roundTrip(t, conn, map[string]any{"v": 1, "id": "1", "type": "pair", "payload": map[string]any{"code": code, "name": "iPhone"}})
	if reply["ok"] != true {
		t.Fatalf("pair %#v", reply)
	}
	payload, _ := reply["payload"].(map[string]any)
	token, _ := payload["token"].(string)
	if token == "" {
		t.Fatal("missing token")
	}
	if server.Code() == code {
		t.Fatal("pairing code was not rotated")
	}
	status := roundTrip(t, conn, map[string]any{"v": 1, "id": "2", "type": "status.get", "payload": map[string]any{}})
	if status["ok"] != true {
		t.Fatalf("status %#v", status)
	}
	roundTrip(t, conn, map[string]any{"v": 1, "id": "3", "type": "input.move", "payload": map[string]any{"dx": 4, "dy": 5}})
	desk.mu.Lock()
	moved := desk.moves
	desk.mu.Unlock()
	if moved != 9 {
		t.Fatalf("move %d", moved)
	}
	denied := roundTrip(t, conn, map[string]any{"v": 1, "id": "4", "type": "power.action", "payload": map[string]any{"action": "shutdown"}})
	if denied["ok"] != false {
		t.Fatalf("shutdown without hold %#v", denied)
	}
	locked := roundTrip(t, conn, map[string]any{"v": 1, "id": "5", "type": "power.action", "payload": map[string]any{"action": "lock"}})
	if locked["ok"] != true {
		t.Fatalf("lock %#v", locked)
	}
	if _, err := conn.Write(maskText(mustJSON(t, map[string]any{"v": 1, "id": "6", "type": "screen.subscribe", "payload": map[string]any{"fps": 12}}))); err != nil {
		t.Fatal(err)
	}
	sawFrame := false
	sawReply := false
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for i := 0; i < 4 && (!sawFrame || !sawReply); i++ {
		frame := readFrame(t, conn)
		if frame[0]&0x0f == 0x2 && bytes.Contains(payloadOf(frame), []byte{0x01}) {
			sawFrame = true
			continue
		}
		var reply map[string]any
		if err := json.Unmarshal(payloadOf(frame), &reply); err == nil && reply["id"] == "6" && reply["ok"] == true {
			sawReply = true
		}
	}
	if !sawReply || !sawFrame {
		t.Fatalf("screen reply %v frame %v", sawReply, sawFrame)
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	host := conn.RemoteAddr().String()
	_ = host
	url := "https://" + addr(server.Port()) + "/api/upload"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte("hello")))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = addr(server.Port())
	req.Header.Set("Origin", "https://"+addr(server.Port()))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Filename", "note.txt")
	req.Header.Set("Cookie", "__Host-pult-session="+token)
	req.ContentLength = 5
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		text, _ := io.ReadAll(res.Body)
		t.Fatalf("upload %d %s", res.StatusCode, text)
	}
}

func addr(port int) string {
	return "127.0.0.1:" + itoa(port)
}

func itoa(value int) string {
	return jsonNumber(value)
}

func jsonNumber(value int) string {
	return string(appendInt(nil, value))
}

func appendInt(dst []byte, value int) []byte {
	return append(dst, []byte(strconvItoa(value))...)
}

func strconvItoa(value int) string {
	if value == 0 {
		return "0"
	}
	var buf [16]byte
	i := len(buf)
	for value > 0 {
		i--
		buf[i] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[i:])
}

func dialPult(t *testing.T, port int) net.Conn {
	t.Helper()
	raw, err := tls.Dial("tcp", addr(port), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	var conn net.Conn = raw
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	_, err = io.WriteString(conn, "GET /pult HTTP/1.1\r\nHost: "+addr(port)+"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "+key+"\r\nSec-WebSocket-Version: 13\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains([]byte(status), []byte("101")) {
		t.Fatal(status)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	buffered := reader.Buffered()
	if buffered > 0 {
		extra := make([]byte, buffered)
		_, _ = io.ReadFull(reader, extra)
		conn = &prefixConn{Conn: conn, prefix: extra}
	}
	return conn
}

type prefixConn struct {
	net.Conn
	prefix []byte
}

func (c *prefixConn) Read(p []byte) (int, error) {
	if len(c.prefix) > 0 {
		n := copy(p, c.prefix)
		c.prefix = c.prefix[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

func roundTrip(t *testing.T, conn net.Conn, payload map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(maskText(raw)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	frame := readFrame(t, conn)
	body := payloadOf(frame)
	var reply map[string]any
	if err := json.Unmarshal(body, &reply); err != nil {
		t.Fatalf("reply %s: %v", body, err)
	}
	return reply
}

func maskText(payload []byte) []byte {
	mask := []byte{9, 8, 7, 6}
	head := []byte{0x81}
	switch {
	case len(payload) < 126:
		head = append(head, byte(len(payload))|0x80)
	default:
		head = append(head, 126|0x80, byte(len(payload)>>8), byte(len(payload)))
	}
	head = append(head, mask...)
	out := append(head, payload...)
	for i := range payload {
		out[len(head)+i] ^= mask[i%4]
	}
	return out
}

func readFrame(t *testing.T, conn net.Conn) []byte {
	t.Helper()
	head := make([]byte, 2)
	if _, err := io.ReadFull(conn, head); err != nil {
		t.Fatal(err)
	}
	length := int(head[1] & 0x7f)
	switch length {
	case 126:
		extra := make([]byte, 2)
		if _, err := io.ReadFull(conn, extra); err != nil {
			t.Fatal(err)
		}
		length = int(binary.BigEndian.Uint16(extra))
		head = append(head, extra...)
	case 127:
		extra := make([]byte, 8)
		if _, err := io.ReadFull(conn, extra); err != nil {
			t.Fatal(err)
		}
		length = int(binary.BigEndian.Uint64(extra))
		head = append(head, extra...)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(conn, body); err != nil {
		t.Fatal(err)
	}
	return append(head, body...)
}

func payloadOf(frame []byte) []byte {
	if len(frame) < 2 {
		return nil
	}
	length := int(frame[1] & 0x7f)
	start := 2
	if length == 126 && len(frame) >= 4 {
		start = 4
	}
	if length == 127 && len(frame) >= 10 {
		start = 10
	}
	if start > len(frame) {
		return nil
	}
	return frame[start:]
}

func TestPlainHTTPSetupAndPing(t *testing.T) {
	dir := t.TempDir()
	phones, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	material, err := cert.Load(dir, []string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	server := New(&fakeDesktop{}, phones)
	server.HostID = phones.HostID()
	go func() { _ = server.Serve(material, 0) }()
	t.Cleanup(func() { _ = server.Close() })
	deadline := time.Now().Add(3 * time.Second)
	for (server.Port() == 0 || server.HTTPPort() == 0) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !bytes.Contains([]byte(server.Bound()), []byte("0.0.0.0:")) || !bytes.Contains([]byte(server.PlainBound()), []byte("0.0.0.0:")) {
		t.Fatalf("bind https=%s http=%s", server.Bound(), server.PlainBound())
	}
	ping := getBody(t, "http://127.0.0.1:"+strconvItoa(server.HTTPPort())+"/ping")
	if ping.status != 200 || !bytes.HasPrefix(ping.body, []byte("ok")) {
		t.Fatalf("ping %d %s", ping.status, ping.body)
	}
	setup := getBody(t, "http://127.0.0.1:"+strconvItoa(server.HTTPPort())+"/setup")
	if setup.status != 200 || !bytes.Contains(setup.body, []byte("4721")) {
		t.Fatalf("setup %d", setup.status)
	}
	denied := getBody(t, "http://127.0.0.1:"+strconvItoa(server.HTTPPort())+"/app.js")
	if denied.status != 404 {
		t.Fatalf("plain app.js %d", denied.status)
	}
}

type httpBody struct {
	status int
	body   []byte
}

func getBody(t *testing.T, url string) httpBody {
	t.Helper()
	var last error
	for attempt := 0; attempt < 20; attempt++ {
		response, err := http.Get(url)
		if err != nil {
			last = err
			time.Sleep(20 * time.Millisecond)
			continue
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return httpBody{status: response.StatusCode, body: body}
	}
	t.Fatal(last)
	return httpBody{}
}

func mustJSON(t *testing.T, payload map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
