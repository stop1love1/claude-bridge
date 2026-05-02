//go:build !windows

package spawn

import (
	"os"
	"syscall"
)

// processAliveImpl uses POSIX signal-0: returns true iff the process
// exists and we have permission to signal it. ESRCH means the PID is
// gone (zombie reaped or never existed); EPERM means it exists but
// we can't signal it — still alive from our perspective.
func processAliveImpl(p *os.Process) bool {
	if p == nil {
		return false
	}
	err := p.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	if err == syscall.EPERM {
		return true
	}
	return false
}
