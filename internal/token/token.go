// Package token manages the per-server authentication token that gates access
// to mo's HTTP API. The token is generated when a server starts and persisted
// to a user-only (0600) file under the XDG state directory, keyed by port. The
// local CLI reads it to authenticate against a running server; the browser SPA
// receives it as a SameSite=Strict cookie. A remote or cross-site caller can do
// neither, which prevents abuse of the (intentionally) unrestricted file-open
// API without limiting which local files the user may open.
package token

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/k1LoW/mo/internal/xdg"
)

// Dir returns the path to the token directory.
func Dir() (string, error) {
	stateHome, err := xdg.StateHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(stateHome, "mo", "token"), nil
}

// Path returns the token file path for the given port.
func Path(port int) (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, fmt.Sprintf("mo-%d.token", port)), nil
}

// Generate returns a new random 256-bit token as a hex string.
func Generate() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// Save atomically writes the token to the token file for the given port with
// owner-only permissions.
func Save(port int, tok string) (retErr error) {
	p, err := Path(port)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("failed to create token directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, "mo-token-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		if retErr != nil {
			os.Remove(tmpName) //nolint:gosec // Path is from our own CreateTemp, not user-supplied
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to set token file permissions: %w", err)
	}
	if _, err := tmp.WriteString(tok); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write token: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close temp file: %w", err)
	}

	if err := os.Rename(tmpName, p); err != nil { //nolint:gosec // Both paths are from our own Path() and CreateTemp
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	return nil
}

// Load reads the token for the given port. It returns ("", nil) if no token
// file exists.
func Load(port int) (string, error) {
	p, err := Path(port)
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(p) //nolint:gosec // Path is from our own Path(), keyed by port
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("failed to read token file: %w", err)
	}

	return strings.TrimSpace(string(data)), nil
}

// Remove deletes the token file for the given port. It returns nil if the file
// does not exist.
func Remove(port int) error {
	p, err := Path(port)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove token file: %w", err)
	}
	return nil
}
