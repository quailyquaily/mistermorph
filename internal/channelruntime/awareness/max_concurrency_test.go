package awareness

import (
	"testing"

	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
)

// Omitted and invalid limits fall back to the shared default of 8; explicit limits, including 1,
// are kept.
func TestCronMaxConcurrencyDefaultsToEightAndKeepsOverrides(t *testing.T) {
	for _, tc := range []struct {
		name     string
		in, want int
	}{
		{name: "omitted", in: 0, want: 8},
		{name: "invalid", in: -2, want: 8},
		{name: "serial", in: 1, want: 1},
		{name: "explicit", in: 12, want: 12},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeRunOptions(RunOptions{CronMaxConcurrency: tc.in}, runtimepaths.Paths{}).CronMaxConcurrency; got != tc.want {
				t.Fatalf("CronMaxConcurrency = %d, want %d", got, tc.want)
			}
		})
	}
}
