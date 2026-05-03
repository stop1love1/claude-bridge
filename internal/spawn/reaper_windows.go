//go:build windows

package spawn

import "os"

// processAliveImpl on Windows trusts that os.Process is alive when
// the wait goroutine hasn't yet populated cmd.ProcessState. A full
// liveness check would need OpenProcess + GetExitCodeProcess via the
// `syscall` package — overkill for a belt-and-suspenders reaper given
// (a) the wait goroutine is the primary cleanup path and (b) the
// reaper's SweepOnce already short-circuits via the cmd.ProcessState
// nil check before reaching processAlive, so the trivially-dead case
// is detected without us. Returning true here just means the registry
// entry stays one more sweep tick if Wait somehow lost the race.
//
// If a future change to the spawn lifecycle ever drops the Wait
// goroutine (or moves cleanup off the wait goroutine entirely), this
// helper would need a real OpenProcess/GetExitCodeProcess
// implementation; for now it is intentionally trivial.
func processAliveImpl(p *os.Process) bool {
	return p != nil
}
