package secref

import "testing"

func TestOSStoreNameFor(t *testing.T) {
	for goos, want := range map[string]string{
		"darwin":  OSStoreMacOSKeychain,
		"windows": OSStoreWindowsCredentialManager,
		"linux":   OSStoreSecretService,
		"plan9":   OSStoreSystem,
	} {
		if got := osStoreNameFor(goos); got != want {
			t.Errorf("osStoreNameFor(%q) = %q, want %q", goos, got, want)
		}
	}
}
