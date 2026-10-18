// Package ws is the small WebSocket server the phone speaks.
package ws

import (
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"sync"
)

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// AcceptKey is the Sec-WebSocket-Accept value.
func AcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + guid))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// Conn is one accepted socket.
type Conn struct {
	raw     net.Conn
	mu      sync.Mutex
	buf     []byte
	alive   bool
	onText  func([]byte)
	onClose func()
}

// Handshake writes the 101 response. The caller already checked the path and key.
func Handshake(raw net.Conn, key string) (*Conn, error) {
	_, err := io.WriteString(raw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+AcceptKey(key)+"\r\n\r\n")
	if err != nil {
		return nil, err
	}
	return &Conn{raw: raw, alive: true}, nil
}

// OnText receives complete text frames.
func (c *Conn) OnText(fn func([]byte)) { c.onText = fn }

// OnClose runs once when the socket ends.
func (c *Conn) OnClose(fn func()) { c.onClose = fn }

// WriteText sends a server text frame.
func (c *Conn) WriteText(text []byte) error { return c.write(0x1, text) }

// WriteBinary sends a server binary frame.
func (c *Conn) WriteBinary(payload []byte) error { return c.write(0x2, payload) }

func (c *Conn) write(opcode byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.alive {
		return fmt.Errorf("сокет закрыт")
	}
	header := frameHeader(opcode, len(payload))
	if _, err := c.raw.Write(header); err != nil {
		return err
	}
	_, err := c.raw.Write(payload)
	return err
}

func frameHeader(opcode byte, length int) []byte {
	head := []byte{0x80 | opcode}
	switch {
	case length < 126:
		head = append(head, byte(length))
	case length < 65536:
		head = append(head, 126, byte(length>>8), byte(length))
	default:
		head = append(head, 127, 0, 0, 0, 0, byte(length>>24), byte(length>>16), byte(length>>8), byte(length))
	}
	return head
}

// Close sends a close frame and shuts the socket.
func (c *Conn) Close() {
	c.mu.Lock()
	if c.alive {
		c.alive = false
		_, _ = c.raw.Write([]byte{0x88, 0x00})
		_ = c.raw.Close()
	}
	c.mu.Unlock()
	if c.onClose != nil {
		c.onClose()
		c.onClose = nil
	}
}

// ReadLoop blocks until the client disconnects.
func (c *Conn) ReadLoop() {
	defer c.Close()
	scratch := make([]byte, 32*1024)
	for {
		n, err := c.raw.Read(scratch)
		if n > 0 {
			c.buf = append(c.buf, scratch[:n]...)
			if err := c.drain(); err != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (c *Conn) drain() error {
	for {
		if len(c.buf) < 2 {
			return nil
		}
		opcode := c.buf[0] & 0x0f
		masked := c.buf[1]&0x80 != 0
		length := int(c.buf[1] & 0x7f)
		offset := 2
		switch length {
		case 126:
			if len(c.buf) < 4 {
				return nil
			}
			length = int(c.buf[2])<<8 | int(c.buf[3])
			offset = 4
		case 127:
			if len(c.buf) < 10 {
				return nil
			}
			length = int(c.buf[6])<<24 | int(c.buf[7])<<16 | int(c.buf[8])<<8 | int(c.buf[9])
			offset = 10
		}
		if length < 0 || length > 1024*1024 {
			return fmt.Errorf("кадр слишком большой")
		}
		maskLen := 0
		if masked {
			maskLen = 4
		}
		if len(c.buf) < offset+maskLen+length {
			return nil
		}
		payload := append([]byte(nil), c.buf[offset+maskLen:offset+maskLen+length]...)
		if masked {
			mask := c.buf[offset : offset+4]
			for i := range payload {
				payload[i] ^= mask[i&3]
			}
		} else if opcode != 0x8 {
			return fmt.Errorf("клиент должен маскировать кадры")
		}
		c.buf = c.buf[offset+maskLen+length:]
		switch opcode {
		case 0x8:
			return fmt.Errorf("закрыто")
		case 0x9:
			_ = c.write(0xA, payload)
		case 0x1:
			if c.onText != nil {
				c.onText(payload)
			}
		}
	}
}
