// Package desktop is the Windows session: screen, input, audio, clipboard, power and apps.
// The release executable calls Win32 directly. Tests use a stand-in that records calls.
package desktop

// Status is what the phone shows on the computer card.
type Status struct {
	Unavailable bool     `json:"unavailable,omitempty"`
	Reason      string   `json:"reason,omitempty"`
	Battery     *int     `json:"battery"`
	Volume      *int     `json:"volume"`
	Muted       bool     `json:"muted"`
	Asleep      bool     `json:"asleep"`
	Locked      bool     `json:"locked"`
	Media       any      `json:"media"`
	AppsRunning []string `json:"appsRunning"`
}

// App is one Start menu shortcut.
type App struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Running bool   `json:"running"`
}

// Note is one forwarded notification. Windows does not let an ordinary
// program read Action Center, so the list stays empty.
type Note struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Desktop performs one local action. Implementations must not start a shell.
type Desktop interface {
	Status() (Status, error)
	Capture() (jpeg []byte, width int, height int, err error)
	Move(dx, dy int) error
	Click(button string, count int) error
	Scroll(dx, dy int) error
	Key(key string, down bool) error
	Text(text string) error
	Volume(level *int, muted *bool) error
	Media(action string) error
	Apps() ([]App, error)
	Launch(id string) error
	Clipboard() (string, error)
	SetClipboard(text string) error
	Notifications() ([]Note, error)
	Power(action string) error
	Close() error
}
