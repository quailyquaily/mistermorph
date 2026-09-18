//go:build windows

package fsstore

import (
	"context"
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func acquireLockFile(ctx context.Context, lockPath string) (func(), error) {
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, defaultFilePerm)
	if err != nil {
		return nil, fmt.Errorf("%w: open %s: %v", ErrLockUnavailable, lockPath, err)
	}
	handle := windows.Handle(file.Fd())
	var overlapped windows.Overlapped
	for {
		err = windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
		if err == nil {
			writeLockDebugMetadata(file, lockPath)
			return func() {
				_ = windows.UnlockFileEx(handle, 0, 1, 0, &overlapped)
				_ = file.Close()
			}, nil
		}
		if !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			_ = file.Close()
			return nil, fmt.Errorf("%w: lock %s: %v", ErrLockUnavailable, lockPath, err)
		}
		if waitErr := waitForLockRetry(ctx, lockPath); waitErr != nil {
			_ = file.Close()
			return nil, waitErr
		}
	}
}
