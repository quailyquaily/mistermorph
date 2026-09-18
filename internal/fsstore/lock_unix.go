//go:build !windows

package fsstore

import (
	"context"
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func acquireLockFile(ctx context.Context, lockPath string) (func(), error) {
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, defaultFilePerm)
	if err != nil {
		return nil, fmt.Errorf("%w: open %s: %v", ErrLockUnavailable, lockPath, err)
	}

	fd := int(file.Fd())
	for {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			if waitErr := waitForLockRetry(ctx, lockPath); waitErr != nil {
				_ = file.Close()
				return nil, waitErr
			}
			continue
		}
		_ = file.Close()
		return nil, fmt.Errorf("%w: flock %s: %v", ErrLockUnavailable, lockPath, err)
	}
	writeLockDebugMetadata(file, lockPath)
	return func() {
		_ = unix.Flock(fd, unix.LOCK_UN)
		_ = file.Close()
	}, nil
}
