package firewall

import "testing"

func TestPublicProfileIsNotOpened(t *testing.T) {
	if Decide(ProfilePublic).Apply {
		t.Fatal("public profile would be opened")
	}
	if Decide(ProfilePublic | ProfilePrivate).Apply {
		t.Fatal("mixed public profile would be opened")
	}
	if !Decide(ProfilePrivate).Apply {
		t.Fatal("private profile was skipped")
	}
}
