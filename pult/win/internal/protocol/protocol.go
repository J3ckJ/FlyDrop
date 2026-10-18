// Package protocol is the Pult v1 message set shared with the Node agent and the Swift package.
package protocol

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"unicode/utf8"
)

const Version = 1

const (
	MaxMessageBytes = 256 * 1024
	MaxFrameBytes   = 1024 * 1024
	MaxTextChars    = 50_000
	MaxName         = 40
	MaxTypeLength   = 2000
	MaxFileBytes    = 1024 * 1024 * 1024
	MaxFps          = 12
	PairingAttempts = 5
)

var (
	macPattern = regexp.MustCompile(`(?i)^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$`)
	keyPattern = regexp.MustCompile(`^[a-z0-9]$|^(enter|escape|tab|backspace|space|up|down|left|right|ctrl|alt|shift|win|meta|f[1-9]|f1[0-2])$`)
	powerSet   = map[string]bool{"sleep": true, "lock": true, "restart": true, "shutdown": true}
	mediaSet   = map[string]bool{"play": true, "pause": true, "toggle": true, "next": true, "previous": true}
	buttonSet  = map[string]bool{"left": true, "right": true, "middle": true}
	transfer   = map[string]bool{"uploading": true, "done": true, "cancelled": true, "error": true}
)

// ClientTypes is the command list the phone may send. A new command has to be
// validated below; the test fails when this slice and the validators diverge.
var ClientTypes = []string{
	"hello", "pair", "status.get", "screen.subscribe", "screen.unsubscribe",
	"input.move", "input.click", "input.scroll", "input.key", "input.text",
	"volume.set", "media.command", "apps.list", "apps.launch",
	"clipboard.get", "clipboard.set", "notifications.list", "power.action",
	"wol.wake", "wol.schedule.list", "wol.schedule.put", "wol.schedule.delete",
	"flydrop.progress", "flydrop.info",
}

// Message is one client command.
type Message struct {
	V       int
	ID      string
	Type    string
	Payload map[string]any
}

// Parse checks a text frame the same way the Node agent does.
func Parse(raw string) (Message, error) {
	if len(raw) > MaxMessageBytes {
		return Message{}, fmt.Errorf("Слишком большое сообщение")
	}
	var body struct {
		V       int            `json:"v"`
		ID      any            `json:"id"`
		Type    string         `json:"type"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		return Message{}, fmt.Errorf("Некорректное сообщение")
	}
	if body.V != Version {
		return Message{}, fmt.Errorf("Неподдерживаемая версия протокола")
	}
	if !known(body.Type) {
		return Message{}, fmt.Errorf("Неизвестная команда")
	}
	id := ""
	if body.ID != nil {
		text, ok := body.ID.(string)
		if !ok || len(text) > 64 {
			return Message{}, fmt.Errorf("Некорректный идентификатор")
		}
		id = text
	}
	payload := body.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	if err := check(body.Type, payload); err != nil {
		return Message{}, err
	}
	return Message{V: Version, ID: id, Type: body.Type, Payload: payload}, nil
}

func known(command string) bool {
	for _, item := range ClientTypes {
		if item == command {
			return true
		}
	}
	return false
}

func check(command string, payload map[string]any) error {
	switch command {
	case "hello":
		if err := optionalName(payload["name"]); err != nil {
			return err
		}
		if token, ok := payload["token"]; ok && token != nil {
			text, ok := token.(string)
			if !ok || len(text) > 128 {
				return fmt.Errorf("Некорректный ключ")
			}
		}
		return nil
	case "pair":
		code, _ := payload["code"].(string)
		if len(code) != 6 || !digits(code) {
			return fmt.Errorf("Код — шесть цифр")
		}
		return optionalName(payload["name"])
	case "screen.subscribe":
		if payload["fps"] == nil {
			return nil
		}
		fps, ok := number(payload["fps"])
		if !ok || fps != math.Trunc(fps) || fps < 1 || fps > MaxFps {
			return fmt.Errorf("Частота кадров от 1 до 12")
		}
		return nil
	case "screen.unsubscribe", "status.get", "apps.list", "clipboard.get", "notifications.list", "wol.schedule.list", "flydrop.info":
		return nil
	case "input.move", "input.scroll":
		dx, okx := number(payload["dx"])
		dy, oky := number(payload["dy"])
		if !okx || !oky {
			return fmt.Errorf("Некорректное смещение")
		}
		if math.Abs(dx) > 8000 || math.Abs(dy) > 8000 {
			return fmt.Errorf("Слишком большое смещение")
		}
		return nil
	case "input.click":
		button, _ := payload["button"].(string)
		if button == "" {
			button = "left"
		}
		if !buttonSet[button] {
			return fmt.Errorf("Некорректная кнопка")
		}
		if payload["count"] != nil {
			count, ok := number(payload["count"])
			if !ok || count != math.Trunc(count) || count < 1 || count > 3 {
				return fmt.Errorf("Некорректный щелчок")
			}
		}
		return nil
	case "input.key":
		key, _ := payload["key"].(string)
		if !keyPattern.MatchString(key) {
			return fmt.Errorf("Некорректная клавиша")
		}
		if _, ok := payload["down"].(bool); !ok {
			return fmt.Errorf("Некорректное состояние клавиши")
		}
		if payload["modifiers"] != nil {
			if _, ok := payload["modifiers"].([]any); !ok {
				return fmt.Errorf("Некорректные модификаторы")
			}
		}
		return nil
	case "input.text":
		text, ok := payload["text"].(string)
		if !ok || len(text) > MaxTypeLength {
			return fmt.Errorf("Слишком длинный текст")
		}
		return nil
	case "volume.set":
		if payload["level"] == nil && payload["muted"] == nil {
			return fmt.Errorf("Не указана громкость")
		}
		if payload["level"] != nil {
			level, ok := number(payload["level"])
			if !ok || level != math.Trunc(level) || level < 0 || level > 100 {
				return fmt.Errorf("Громкость от 0 до 100")
			}
		}
		if payload["muted"] != nil {
			if _, ok := payload["muted"].(bool); !ok {
				return fmt.Errorf("Некорректное состояние звука")
			}
		}
		return nil
	case "media.command":
		action, _ := payload["action"].(string)
		if !mediaSet[action] {
			return fmt.Errorf("Неизвестная команда плеера")
		}
		return nil
	case "apps.launch":
		id, ok := payload["id"].(string)
		if !ok || len(id) == 0 || len(id) > 300 || id == " " {
			return fmt.Errorf("Некорректное приложение")
		}
		for _, r := range id {
			if r == ' ' {
				continue
			}
			if r <= ' ' {
				return fmt.Errorf("Некорректное приложение")
			}
		}
		if !containsNonSpace(id) {
			return fmt.Errorf("Некорректное приложение")
		}
		return nil
	case "clipboard.set":
		text, ok := payload["text"].(string)
		if !ok || utf8.RuneCountInString(text) > MaxTextChars {
			return fmt.Errorf("Текст буфера длиннее 50 000 символов")
		}
		return nil
	case "power.action":
		action, _ := payload["action"].(string)
		if !powerSet[action] {
			return fmt.Errorf("Неизвестное действие питания")
		}
		if action == "shutdown" && payload["hold"] != true {
			return fmt.Errorf("Выключение только удержанием")
		}
		if payload["force"] != nil {
			if _, ok := payload["force"].(bool); !ok {
				return fmt.Errorf("Некорректное подтверждение")
			}
		}
		return nil
	case "wol.wake":
		mac, _ := payload["mac"].(string)
		if !macPattern.MatchString(mac) {
			return fmt.Errorf("Некорректный MAC-адрес")
		}
		return nil
	case "wol.schedule.put":
		mac, _ := payload["mac"].(string)
		if !macPattern.MatchString(mac) {
			return fmt.Errorf("Некорректный MAC-адрес")
		}
		label, _ := payload["label"].(string)
		if label == "" || utf8.RuneCountInString(label) > 80 {
			return fmt.Errorf("Введите название сценария")
		}
		hour, okh := number(payload["hour"])
		minute, okm := number(payload["minute"])
		if !okh || hour != math.Trunc(hour) || hour < 0 || hour > 23 {
			return fmt.Errorf("Час от 0 до 23")
		}
		if !okm || minute != math.Trunc(minute) || minute < 0 || minute > 59 {
			return fmt.Errorf("Минута от 0 до 59")
		}
		if payload["id"] != nil {
			id, ok := payload["id"].(string)
			if !ok || len(id) > 64 {
				return fmt.Errorf("Некорректный сценарий")
			}
		}
		return nil
	case "wol.schedule.delete":
		id, ok := payload["id"].(string)
		if !ok || id == "" {
			return fmt.Errorf("Некорректный сценарий")
		}
		return nil
	case "flydrop.progress":
		name, ok := payload["name"].(string)
		if !ok || len(name) > 180 {
			return fmt.Errorf("Некорректное имя файла")
		}
		state, _ := payload["state"].(string)
		if !transfer[state] {
			return fmt.Errorf("Некорректное состояние передачи")
		}
		loaded, okl := number(payload["loaded"])
		total, okt := number(payload["total"])
		if !okl || !okt || loaded < 0 || total < 0 || total > MaxFileBytes {
			return fmt.Errorf("Некорректный прогресс")
		}
		return nil
	default:
		return fmt.Errorf("Нет проверки для %s", command)
	}
}

func optionalName(value any) error {
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok || utf8.RuneCountInString(text) > MaxName {
		return fmt.Errorf("Некорректное имя")
	}
	return nil
}

func digits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func containsNonSpace(value string) bool {
	for _, r := range value {
		if r != ' ' {
			return true
		}
	}
	return false
}

func number(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

// Result is a successful reply.
func Result(request Message, payload any) ([]byte, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	return json.Marshal(map[string]any{
		"v": request.V, "id": request.ID, "type": request.Type, "ok": true, "payload": payload,
	})
}

// Failure is an error reply.
func Failure(request Message, message string) ([]byte, error) {
	id := any(request.ID)
	if request.ID == "" {
		id = nil
	}
	command := request.Type
	if command == "" {
		command = "error"
	}
	return json.Marshal(map[string]any{
		"v": Version, "id": id, "type": command, "ok": false, "error": message,
	})
}

// Event is a server push without an id.
func Event(command string, payload any) ([]byte, error) {
	return json.Marshal(map[string]any{"v": Version, "type": command, "payload": payload})
}

// EncodeFrame packs a JPEG the way the PWA reads it.
func EncodeFrame(jpeg []byte, seq uint64, width, height int) ([]byte, error) {
	header, err := json.Marshal(map[string]any{"seq": seq, "width": width, "height": height})
	if err != nil {
		return nil, err
	}
	if len(header) > 65535 {
		return nil, fmt.Errorf("Слишком большой заголовок кадра")
	}
	out := make([]byte, 3+len(header)+len(jpeg))
	out[0] = 0x01
	out[1] = byte(len(header) >> 8)
	out[2] = byte(len(header))
	copy(out[3:], header)
	copy(out[3+len(header):], jpeg)
	return out, nil
}

// DecodeFrame reverses EncodeFrame. Tests use it to check the layout.
func DecodeFrame(frame []byte) (seq uint64, width, height int, jpeg []byte, err error) {
	if len(frame) < 5 || frame[0] != 0x01 {
		return 0, 0, 0, nil, fmt.Errorf("Некорректный кадр")
	}
	length := int(frame[1])<<8 | int(frame[2])
	if 3+length > len(frame) {
		return 0, 0, 0, nil, fmt.Errorf("Кадр обрезан")
	}
	var meta struct {
		Seq    uint64 `json:"seq"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	if err := json.Unmarshal(frame[3:3+length], &meta); err != nil {
		return 0, 0, 0, nil, err
	}
	return meta.Seq, meta.Width, meta.Height, frame[3+length:], nil
}

// MagicPacket is the Wake-on-LAN payload for a MAC address.
func MagicPacket(mac string) ([]byte, error) {
	if !macPattern.MatchString(mac) {
		return nil, fmt.Errorf("Некорректный MAC-адрес")
	}
	parts := splitMac(mac)
	packet := make([]byte, 6+16*6)
	for i := 0; i < 6; i++ {
		packet[i] = 0xff
	}
	for repeat := 0; repeat < 16; repeat++ {
		copy(packet[6+repeat*6:], parts)
	}
	return packet, nil
}

func splitMac(mac string) []byte {
	out := make([]byte, 6)
	index := 0
	value := 0
	have := false
	flush := func() {
		if index < 6 {
			out[index] = byte(value)
			index++
		}
		value = 0
		have = false
	}
	for _, r := range mac {
		switch {
		case r == ':' || r == '-':
			flush()
		case r >= '0' && r <= '9':
			value = value*16 + int(r-'0')
			have = true
		case r >= 'a' && r <= 'f':
			value = value*16 + int(r-'a'+10)
			have = true
		case r >= 'A' && r <= 'F':
			value = value*16 + int(r-'A'+10)
			have = true
		}
	}
	if have {
		flush()
	}
	return out
}
