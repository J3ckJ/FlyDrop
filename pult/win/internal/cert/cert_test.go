package cert

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"
)

func TestLeafIsSignedByAStableLocalCA(t *testing.T) {
	dir := t.TempDir()
	first, err := Load(dir, []string{"192.168.1.24"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Load(dir, []string{"192.168.1.24"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatal("CA changed between launches")
	}
	pair, err := tls.X509KeyPair(first.Cert, first.Key)
	if err != nil {
		t.Fatal(err)
	}
	if len(pair.Certificate) == 0 {
		t.Fatal("no leaf")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(first.CA) {
		t.Fatal("CA pem rejected")
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "localhost"}); err != nil {
		t.Fatal(err)
	}
	profile := MobileConfig(first, "0123456789abcdef")
	if len(profile) < 100 || !contains(profile, first.Fingerprint) {
		t.Fatal("profile missing fingerprint")
	}
	if _, err := os.Stat(filepath.Join(dir, "ca.key")); err != nil {
		t.Fatal(err)
	}
}

func contains(text, part string) bool {
	return len(part) > 0 && len(text) >= len(part) && (text == part || len(text) > 0 && (indexOf(text, part) >= 0))
}

func indexOf(text, part string) int {
	for i := 0; i+len(part) <= len(text); i++ {
		if text[i:i+len(part)] == part {
			return i
		}
	}
	return -1
}
