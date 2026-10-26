package chatcmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate/seal"
)

// checkRuntimeIdentity runs when chat connects to a runtime, before the chat opens. It pins the
// runtime's identity key, which approvals for elevated commands are sealed to: silently for a
// runtime on this machine, after the person confirmed its fingerprint otherwise. A key that
// differs from the pinned one is reported here; approval cards then refuse it. Nothing here stops
// the chat: a runtime that offers no identity, or one the person does not confirm, is checked
// again on its first approval card.
func checkRuntimeIdentity(ctx context.Context, c *remoteClient, path string, in io.Reader, out io.Writer) {
	var info daemonruntime.ElevationIdentity
	if err := c.request(ctx, "GET", "/elevation/identity", nil, &info); err != nil {
		var he *remoteHTTPError
		if !errors.As(err, &he) || he.status != http.StatusNotFound {
			_, _ = fmt.Fprintf(out, "Cannot read the runtime's identity key (%v); approval cards will ask you to check its fingerprint.\n", err)
		}
		return
	}
	identity, err := seal.DecodePublicKey(info.Identity)
	if err != nil {
		_, _ = fmt.Fprintln(out, "The runtime sent no valid identity key; approval cards will ask you to check its fingerprint.")
		return
	}
	// The fingerprint is computed here, not taken from the runtime.
	fingerprint := seal.Fingerprint(identity)
	key := c.base
	known, err := loadKnownRuntimes(path)
	if err != nil {
		_, _ = fmt.Fprintf(out, "Cannot read the pinned runtime identities: %v\n", err)
		return
	}
	if pinnedText, ok := known[key]; ok {
		pinned, err := seal.DecodePublicKey(pinnedText)
		switch {
		case err != nil:
			_, _ = fmt.Fprintf(out, "The identity pinned for %s in %s is unreadable. Run: mistermorph chat --forget-runtime %s\n", key, path, key)
		case !bytes.Equal(pinned, identity):
			_, _ = fmt.Fprintf(out, "WARNING: the runtime's identity key changed.\n  Pinned: %s\n  Now:    %s\nSomeone may be intercepting the connection, or the Console's state was reset. Elevated commands cannot be approved from chat until you check the fingerprint `mistermorph console fingerprint` prints on the runtime's machine and, if it shows the new one, run: mistermorph chat --forget-runtime %s\n", seal.Fingerprint(pinned), fingerprint, key)
		}
		return
	}
	if !runtimeIsLoopback(key) {
		_, _ = fmt.Fprintf(out, "First connection to %s from chat.\nIts identity fingerprint is:\n    %s\nCheck that it matches what `mistermorph console fingerprint` prints on the runtime's machine.\nTrust this runtime for approving elevated commands? [y/N] ", key, fingerprint)
		answer, err := readAnswerLine(in)
		if err != nil || !isYes(answer) {
			_, _ = fmt.Fprintln(out, "Not trusted. An elevated command will show the fingerprint again on its approval card.")
			return
		}
	}
	if err := pinKnownRuntime(path, key, seal.EncodePublicKey(identity)); err != nil {
		_, _ = fmt.Fprintf(out, "Cannot save the runtime's identity: %v\n", err)
		return
	}
	if !runtimeIsLoopback(key) {
		_, _ = fmt.Fprintf(out, "Trusted; pinned in %s.\n", path)
	}
}

// readAnswerLine reads one line a byte at a time, so nothing past it is taken from the input the
// chat reads next.
func readAnswerLine(in io.Reader) (string, error) {
	var line []byte
	b := make([]byte, 1)
	for {
		n, err := in.Read(b)
		if n == 1 {
			if b[0] == '\n' {
				return string(line), nil
			}
			line = append(line, b[0])
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				return string(line), nil
			}
			return "", err
		}
	}
}

func isYes(answer string) bool {
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
		return true
	}
	return false
}
