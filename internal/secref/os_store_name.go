package secref

import "runtime"

// System secret stores, by the operating system that holds them.
const (
	OSStoreMacOSKeychain            = "macos_keychain"
	OSStoreWindowsCredentialManager = "windows_credential_manager"
	OSStoreSecretService            = "secret_service"
	OSStoreSystem                   = "system"
)

// OSStoreName names the system secret store this process uses: the macOS Keychain, the Windows
// Credential Manager, or the freedesktop Secret Service (GNOME Keyring, KWallet) on Linux.
func OSStoreName() string {
	return osStoreNameFor(runtime.GOOS)
}

func osStoreNameFor(goos string) string {
	switch goos {
	case "darwin":
		return OSStoreMacOSKeychain
	case "windows":
		return OSStoreWindowsCredentialManager
	case "linux", "freebsd", "openbsd", "netbsd":
		return OSStoreSecretService
	default:
		return OSStoreSystem
	}
}
