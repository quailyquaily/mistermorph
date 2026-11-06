//go:build unix

package agentsettings

import (
	"os"
	"syscall"
)

// A file swapped for a pipe between the check and the open must not block the request.
const skillFileOpenFlags = os.O_RDONLY | syscall.O_NONBLOCK
