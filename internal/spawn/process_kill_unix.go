//go:build !windows

package spawn

import (
	"os/exec"
	"syscall"
)

// configureProcAttr puts the child in its own process group so killpg
// can signal the entire descendant tree atomically. Without this, the
// child shares the bridge's process group; signalling -PID would either
// ESRCH (no dedicated group exists) or, in the worst case, hit an
// unrelated group if PIDs happened to collide. With Setpgid the kill
// path can call syscall.Kill(-pid, …) and reach every grandchild the
// claude binary ever spawned.
func configureProcAttr(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killProcessTree sends SIGTERM (or SIGKILL when force=true) to the
// child's process group. Because configureProcAttr set Setpgid=true at
// spawn time, every grandchild claude forked is in the same group and
// receives the signal too — no orphaned tool subprocesses.
//
// Returns nil on best-effort attempt; ESRCH (process gone) is silently
// ignored since the caller re-checks via the registry.
func killProcessTree(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	pid := cmd.Process.Pid
	// Negative pid signals the entire process group with PGID == pid.
	// Setpgid=true at spawn time made the child's PID == its PGID.
	if err := syscall.Kill(-pid, sig); err != nil {
		// ESRCH means the group is gone (child already exited and was
		// reaped). Not an error from the caller's perspective.
		if err == syscall.ESRCH {
			return nil
		}
		// Fall back to signalling the direct child if killpg failed
		// for some other reason — better partial cleanup than none.
		_ = cmd.Process.Signal(sig)
	}
	return nil
}
