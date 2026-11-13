package secref

import (
	"context"
	"errors"
	"testing"
)

func TestOSStoreDisabledValue(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"", false},
		{"0", false},
		{"false", false},
		{"off", false},
		{"no", false},
		{"maybe", false},
		{"1", true},
		{"true", true},
		{" TRUE ", true},
		{"yes", true},
		{"On", true},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			if got := osStoreDisabledValue(tc.raw); got != tc.want {
				t.Fatalf("osStoreDisabledValue(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestNewOSStoreDisabledByEnv(t *testing.T) {
	t.Setenv(OSStoreDisabledEnv, "1")
	if store := NewOSStore(); store != nil {
		t.Fatalf("NewOSStore() = %#v, want nil", store)
	}
	source := NewDefaultSource(AWSSecretsManagerConfig{})
	if _, err := source.GetOSSecretString(context.Background(), "AAAAAAAAAAAAAAAAAAAAAA"); !errors.Is(err, ErrOSStoreUnavailable) {
		t.Fatalf("GetOSSecretString() error = %v, want ErrOSStoreUnavailable", err)
	}
}
