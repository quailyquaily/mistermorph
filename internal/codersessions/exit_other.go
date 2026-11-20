//go:build !linux && !darwin && !dragonfly && !freebsd && !netbsd && !openbsd

package codersessions

// exitWatch cannot see a process exit before it is reaped here: rpc learns of it from Wait.
func exitWatch(pid int) bool { return false }
