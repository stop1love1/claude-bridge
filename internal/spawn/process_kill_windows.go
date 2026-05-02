//go:build windows

package spawn

import (
	"os/exec"
	"strconv"
	"syscall"
)

// configureProcAttr is a no-op on Windows. Process groups are managed
// via Job objects (a future enhancement); for now the kill path uses
// `taskkill /T` to walk the descendant tree.
func configureProcAttr(cmd *exec.Cmd) {
	// Hide the console window the child would otherwise inherit.
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}

// killProcessTree shells out to taskkill /F /T /PID <pid>. The /T flag
// walks the descendant tree so any sub-shell, git invocation, node
// subprocess, etc. that the spawned claude started gets terminated
// alongside it. Without /T, claude.exe dies but the work the user
// actually wanted to stop keeps running invisibly.
//
// force=true adds /F (force kill — equivalent to SIGKILL). force=false
// asks taskkill for a graceful shutdown first, which on Windows is
// effectively a TerminateProcess via the close-window event the child
// usually doesn't handle anyway.
func killProcessTree(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	args := []string{"/T", "/PID", strconv.Itoa(pid)}
	if force {
		args = append([]string{"/F"}, args...)
	}
	tk := exec.Command("taskkill", args...)
	// Don't surface taskkill's "process not found" exit code as an
	// error — kill is best-effort and the caller re-checks via the
	// registry anyway.
	_ = tk.Run()
	return nil
}
