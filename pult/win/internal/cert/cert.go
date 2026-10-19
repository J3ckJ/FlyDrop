// Package cert builds the local ECDSA certificate the phone trusts.
package cert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Material is the TLS listener certificate and the CA the phone installs.
type Material struct {
	Cert        []byte
	Key         []byte
	CA          []byte
	CADer       []byte
	Fingerprint string
}

// Load returns a stable CA from directory and a leaf that names addresses.
func Load(directory string, addresses []string) (Material, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return Material{}, err
	}
	caCert, caKey, err := loadOrCreateCA(directory)
	if err != nil {
		return Material{}, err
	}
	leaf, leafKey, err := issue(caCert, caKey, addresses)
	if err != nil {
		return Material{}, err
	}
	keyBytes, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		return Material{}, err
	}
	sum := sha256.Sum256(caCert.Raw)
	return Material{
		Cert:        pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Raw}),
		Key:         pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyBytes}),
		CA:          pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caCert.Raw}),
		CADer:       caCert.Raw,
		Fingerprint: colon(sum[:]),
	}, nil
}

func loadOrCreateCA(directory string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPath := filepath.Join(directory, "ca.pem")
	keyPath := filepath.Join(directory, "ca.key")
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		block, _ := pem.Decode(certPEM)
		keyBlock, _ := pem.Decode(keyPEM)
		if block != nil && keyBlock != nil {
			parsed, err := x509.ParseCertificate(block.Bytes)
			if err == nil && time.Until(parsed.NotAfter) > 365*24*time.Hour {
				key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
				if err == nil {
					if ec, ok := key.(*ecdsa.PrivateKey); ok {
						return parsed, ec, nil
					}
				}
			}
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Pult Local"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(5 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		MaxPathLenZero:        true,
	}
	applyConstraints(template)
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	keyBytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyBytes}), 0o600); err != nil {
		return nil, nil, err
	}
	return parsed, key, nil
}

func issue(ca *x509.Certificate, caKey *ecdsa.PrivateKey, addresses []string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	ips := []net.IP{net.ParseIP("127.0.0.1")}
	seen := map[string]bool{"127.0.0.1": true}
	for _, address := range addresses {
		if seen[address] || net.ParseIP(address) == nil {
			continue
		}
		seen[address] = true
		ips = append(ips, net.ParseIP(address))
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "Pult"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	return parsed, key, nil
}

func applyConstraints(template *x509.Certificate) {
	template.PermittedDNSDomainsCritical = true
	template.PermittedDNSDomains = []string{"localhost"}
	ranges := []string{"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}
	for _, cidr := range ranges {
		_, network, err := net.ParseCIDR(cidr)
		if err == nil {
			template.PermittedIPRanges = append(template.PermittedIPRanges, network)
		}
	}
}

func colon(sum []byte) string {
	text := hex.EncodeToString(sum)
	out := make([]byte, 0, len(text)+31)
	for i := 0; i < len(text); i += 2 {
		if i > 0 {
			out = append(out, ':')
		}
		out = append(out, text[i], text[i+1])
	}
	return string(bytesToUpper(out))
}

func bytesToUpper(in []byte) []byte {
	for i, b := range in {
		if b >= 'a' && b <= 'f' {
			in[i] = b - 32
		}
	}
	return in
}

// MobileConfig is the Apple profile that trusts the local CA and nothing else.
func MobileConfig(material Material, hostID string) string {
	name := "Pult Local"
	if len(hostID) >= 8 {
		name = "Pult Local " + hostID[:8]
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadCertificateFileName</key><string>Pult.cer</string>
<key>PayloadContent</key><data>%s</data>
<key>PayloadDescription</key><string>Только локальные адреса. SHA-256: %s</string>
<key>PayloadDisplayName</key><string>%s</string>
<key>PayloadIdentifier</key><string>app.flydrop.pult.%s.certificate</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>%s</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDisplayName</key><string>%s</string>
<key>PayloadDescription</key><string>Локальное HTTPS-соединение с вашим компьютером. В профиле только публичный сертификат, без VPN.</string>
<key>PayloadIdentifier</key><string>app.flydrop.pult.%s</string>
<key>PayloadOrganization</key><string>Evgenii Lyubkin</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>%s</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>`, encodeBase64(material.CADer), material.Fingerprint, name, hostID, hostID, name, hostID, hostID)
}

func encodeBase64(raw []byte) string {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	out := make([]byte, 0, (len(raw)+2)/3*4)
	for i := 0; i < len(raw); i += 3 {
		var chunk uint32
		n := 0
		for j := 0; j < 3 && i+j < len(raw); j++ {
			chunk = chunk<<8 | uint32(raw[i+j])
			n++
		}
		chunk <<= uint(8 * (3 - n))
		out = append(out, table[(chunk>>18)&63], table[(chunk>>12)&63])
		if n > 1 {
			out = append(out, table[(chunk>>6)&63])
		} else {
			out = append(out, '=')
		}
		if n > 2 {
			out = append(out, table[chunk&63])
		} else {
			out = append(out, '=')
		}
	}
	return string(out)
}
