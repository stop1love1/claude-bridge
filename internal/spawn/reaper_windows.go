//go:build windows

package spawn

import "os"

// processAliveImpl on Windows trusts that os.Process is alive when
// the wait goroutine hasn't yet populated cmd.ProcessState. A full
// liveness check would need OpenProcess + GetExitCodeProcess via
// syscall — overkill for a belt-and-suspenders reaper given the
// wait goroutine is the primary cleanup path. Returning true here
// just means the registry entry stays one more sweep tick if Wait
// somehow lost the race.
func processAliveImpl(p *os.Process) bool {
	return p != nil
}
