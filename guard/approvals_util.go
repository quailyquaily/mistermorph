package guard

import (
	"crypto/rand"
	"encoding/hex"
)

func randHex(nbytes int) string {
	if nbytes <= 0 {
		nbytes = 12
	}
	b := make([]byte, nbytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
