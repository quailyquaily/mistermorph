package secref

import (
	"os"
	"strconv"
	"strings"
)

// OSStoreDisabledEnv names the environment variable that turns the system secret store off. Set to
// a true value (1, true, yes, on), MisterMorph never touches the macOS Keychain, the Windows
// Credential Manager or the Linux Secret Service: new secrets stay in the 0600 config file as
// given, and an existing ${secret:...} reference fails to resolve.
const OSStoreDisabledEnv = "MISTER_MORPH_DISABLE_KEYRING"

// OSStoreDisabled reports whether OSStoreDisabledEnv turns the system secret store off.
func OSStoreDisabled() bool {
	return osStoreDisabledValue(os.Getenv(OSStoreDisabledEnv))
}

func osStoreDisabledValue(raw string) bool {
	raw = strings.ToLower(strings.TrimSpace(raw))
	switch raw {
	case "yes", "on":
		return true
	}
	disabled, err := strconv.ParseBool(raw)
	return err == nil && disabled
}

// NewOSStore returns the system secret store, or nil when OSStoreDisabledEnv turns it off. Callers
// treat a nil store as no system store.
func NewOSStore() OSStore {
	if OSStoreDisabled() {
		return nil
	}
	return newPlatformOSStore()
}
