// Package store keeps paired phones in the same JSON file the Node agent uses.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Device is one paired phone. The token itself is not stored.
type Device struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	TokenHash string `json:"tokenHash"`
	CreatedAt int64  `json:"createdAt"`
	LastSeen  int64  `json:"lastSeen"`
}

// Schedule is a Wake-on-LAN reminder.
type Schedule struct {
	ID            string `json:"id"`
	MAC           string `json:"mac"`
	Label         string `json:"label"`
	Hour          int    `json:"hour"`
	Minute        int    `json:"minute"`
	LastFiredDate string `json:"lastFiredDate"`
}

type fileData struct {
	HostID        string     `json:"hostId"`
	Devices       []Device   `json:"devices"`
	Schedules     []Schedule `json:"schedules"`
	Subscriptions []any      `json:"subscriptions"`
}

// Store is the on-disk phone list.
type Store struct {
	path string
	data fileData
}

// Open reads or creates directory/devices.json.
func Open(directory string) (*Store, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	store := &Store{path: filepath.Join(directory, "devices.json")}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		store.data = fileData{HostID: newID(), Devices: []Device{}, Schedules: []Schedule{}, Subscriptions: []any{}}
		return store, store.save()
	}
	if err := json.Unmarshal(raw, &store.data); err != nil {
		return nil, fmt.Errorf("Повреждено хранилище Пульта")
	}
	if store.data.HostID == "" || store.data.Devices == nil || store.data.Schedules == nil {
		return nil, fmt.Errorf("Повреждено хранилище Пульта")
	}
	return store, nil
}

// HostID is the stable id used in the certificate profile.
func (s *Store) HostID() string { return s.data.HostID }

// Find returns the device for a raw token.
func (s *Store) Find(token string) *Device {
	if token == "" {
		return nil
	}
	digest := hash(token)
	for i := range s.data.Devices {
		if subtle.ConstantTimeCompare([]byte(s.data.Devices[i].TokenHash), []byte(digest)) == 1 {
			return &s.data.Devices[i]
		}
	}
	return nil
}

// Remember adds a phone and returns the token to show once.
func (s *Store) Remember(name string) (string, Device, error) {
	if len(s.data.Devices) >= 16 {
		return "", Device{}, fmt.Errorf("Достигнут предел телефонов")
	}
	if name == "" {
		name = "iPhone"
	}
	token := newToken()
	device := Device{ID: newID(), Name: name, TokenHash: hash(token), CreatedAt: now(), LastSeen: now()}
	s.data.Devices = append(s.data.Devices, device)
	return token, device, s.save()
}

// Touch updates last seen.
func (s *Store) Touch(id string) error {
	for i := range s.data.Devices {
		if s.data.Devices[i].ID == id {
			s.data.Devices[i].LastSeen = now()
			return s.save()
		}
	}
	return nil
}

// Revoke removes a phone.
func (s *Store) Revoke(id string) (bool, error) {
	next := s.data.Devices[:0]
	removed := false
	for _, device := range s.data.Devices {
		if device.idEquals(id) {
			removed = true
			continue
		}
		next = append(next, device)
	}
	if !removed {
		return false, nil
	}
	s.data.Devices = next
	return true, s.save()
}

func (d Device) idEquals(id string) bool { return d.ID == id }

// Schedules returns the saved reminders.
func (s *Store) Schedules() []Schedule { return append([]Schedule(nil), s.data.Schedules...) }

// PutSchedule inserts or replaces a reminder.
func (s *Store) PutSchedule(item Schedule) (Schedule, error) {
	if item.ID != "" {
		for i := range s.data.Schedules {
			if s.data.Schedules[i].ID == item.ID {
				item.LastFiredDate = s.data.Schedules[i].LastFiredDate
				s.data.Schedules[i] = item
				return item, s.save()
			}
		}
	} else {
		item.ID = newID()
	}
	if len(s.data.Schedules) >= 32 {
		return Schedule{}, fmt.Errorf("Слишком много сценариев")
	}
	s.data.Schedules = append(s.data.Schedules, item)
	return item, s.save()
}

// DeleteSchedule removes a reminder.
func (s *Store) DeleteSchedule(id string) error {
	next := s.data.Schedules[:0]
	for _, item := range s.data.Schedules {
		if item.ID != id {
			next = append(next, item)
		}
	}
	s.data.Schedules = next
	return s.save()
}

// MarkSchedule records that a reminder already fired today.
func (s *Store) MarkSchedule(id, date string) error {
	for i := range s.data.Schedules {
		if s.data.Schedules[i].ID == id {
			s.data.Schedules[i].LastFiredDate = date
			return s.save()
		}
	}
	return nil
}

func (s *Store) save() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.path)
}

func hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newToken() string {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	return base64URL(buf)
}

func newID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	text := hex.EncodeToString(buf)
	return text[0:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

func base64URL(in []byte) string {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	out := make([]byte, 0, (len(in)*8+5)/6)
	var acc uint32
	bits := 0
	for _, b := range in {
		acc = acc<<8 | uint32(b)
		bits += 8
		for bits >= 6 {
			bits -= 6
			out = append(out, table[(acc>>uint(bits))&63])
		}
	}
	if bits > 0 {
		out = append(out, table[(acc<<uint(6-bits))&63])
	}
	return string(out)
}

func now() int64 { return time.Now().UnixMilli() }
