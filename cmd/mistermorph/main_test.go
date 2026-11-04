package main

import (
	"os"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testenv"
)

// Tests here read configuration; keep MISTER_MORPH_* variables from the caller out of them.
func TestMain(m *testing.M) {
	testenv.ClearAppEnv()
	os.Exit(m.Run())
}
