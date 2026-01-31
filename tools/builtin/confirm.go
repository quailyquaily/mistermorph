package builtin

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

func confirmOnTTY(prompt string) (bool, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return false, fmt.Errorf("cannot open /dev/tty for confirmation: %w", err)
	}
	defer tty.Close()

	_, _ = io.WriteString(tty, prompt)
	r := bufio.NewReader(tty)
	line, err := r.ReadString('\n')
	if err != nil && line == "" {
		return false, err
	}
	line = strings.TrimSpace(line)
	return strings.EqualFold(line, "y") || strings.EqualFold(line, "yes"), nil
}
