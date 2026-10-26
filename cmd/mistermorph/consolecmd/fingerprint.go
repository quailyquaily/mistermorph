package consolecmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/quailyquaily/mistermorph/internal/elevate/seal"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// newFingerprintCmd prints the fingerprint of the runtime's identity key, for the person to
// compare with the one an approval card or chat shows. It reads the key; it never makes one.
func newFingerprintCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "fingerprint",
		Short: "Print the fingerprint of the key that elevated-command passwords are encrypted to",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			fingerprint, err := identityFingerprint(runtimepaths.FromReader(viper.GetViper()).StateDir)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), fingerprint)
			return nil
		},
	}
}

func identityFingerprint(stateDir string) (string, error) {
	path := filepath.Join(stateDir, elevationIdentityFile)
	identity, err := seal.ReadIdentity(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("no elevation identity at %s yet: start the Console once to make it", path)
	}
	if err != nil {
		return "", err
	}
	return seal.Fingerprint(identity.PublicKey()), nil
}
