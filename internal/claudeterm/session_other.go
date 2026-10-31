//go:build !unix

package claudeterm

import (
	"context"
	"fmt"
)

const Supported = false

type session struct {
	cwd, id           string
	busy              bool
	resumed, prompted bool
}

func start(Request, string) (*session, error) {
	return nil, fmt.Errorf("Claude terminals require Unix")
}
func (*session) exited() bool { return true }
func (*session) close()       {}
func (*session) run(context.Context, Request) (string, error) {
	return "", fmt.Errorf("Claude terminals require Unix")
}
