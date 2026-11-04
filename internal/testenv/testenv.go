// Package testenv isolates tests from the environment they inherit.
package testenv

import (
	"os"
	"strings"
)

// AppEnvPrefix is the prefix of the environment variables that configure mistermorph.
const AppEnvPrefix = "MISTER_MORPH_"

// ClearAppEnv unsets every MISTER_MORPH_* variable. Call it from TestMain in packages whose tests
// read configuration: a variable inherited from the shell, or from a running mistermorph that
// started the tests, would otherwise override the config those tests write. Tests that need one
// set it themselves with t.Setenv.
func ClearAppEnv() {
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, AppEnvPrefix) {
			_ = os.Unsetenv(name)
		}
	}
}
