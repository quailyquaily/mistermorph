//go:build !unix

package agentsettings

import "os"

const skillFileOpenFlags = os.O_RDONLY
