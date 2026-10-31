//go:build !unix

package claudeterm

import (
	"context"
	"fmt"
)

const Supported = false

type session struct {
	cwd  string
	busy bool
}

func start(Request) (*session, error) { return nil, fmt.Errorf("Claude terminals require Unix") }
func (*session) exited() bool         { return true }
func (*session) close()               {}
func (*session) run(context.Context, Request) (string, error) {
	return "", fmt.Errorf("Claude terminals require Unix")
}
