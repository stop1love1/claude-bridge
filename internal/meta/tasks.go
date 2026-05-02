package meta

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// TaskStatus is the bridge's coarse run state. Mirrors the TS string
// union: "todo" | "doing" | "blocked" | "done".
type TaskStatus string

const (
	TaskStatusTodo    TaskStatus = "todo"
	TaskStatusDoing   TaskStatus = "doing"
	TaskStatusBlocked TaskStatus = "blocked"
	TaskStatusDone    TaskStatus = "done"
)

// TaskSection is the column the task sits in on the board. Note the
// em-dash + spaces in "DONE — not yet archived" — that's the wire shape
// the existing UI expects, so don't normalize it.
type TaskSection string

const (
	SectionTodo    TaskSection = "TODO"
	SectionDoing   TaskSection = "DOING"
	SectionBlocked TaskSection = "BLOCKED"
	SectionDone    TaskSection = "DONE — not yet archived"
)

// SectionStatus maps each section to its canonical status. Matches
// the TS SECTION_STATUS table exactly.
var SectionStatus = map[TaskSection]TaskStatus{
	SectionTodo:    TaskStatusTodo,
	SectionDoing:   TaskStatusDoing,
	SectionBlocked: TaskStatusBlocked,
	SectionDone:    TaskStatusDone,
}

// taskIDRE is the strict task id format: `t_YYYYMMDD_NNN`. Used as
// both the slug and a trust gate before any path join under
// SESSIONS_DIR — anything that doesn't match must be rejected to
// prevent traversal (`..`, `/`, `\`, drive letters, NUL, …).
var taskIDRE = regexp.MustCompile(`^t_\d{8}_\d{3}$`)

// IsValidTaskID reports whether s is a well-formed task id. Mirrors
// libs/tasks.ts isValidTaskId. Uses a closed regex (no slashes / dots
// / NUL) so callers can safely path.Join the result.
func IsValidTaskID(s string) bool {
	return taskIDRE.MatchString(s)
}

// GenerateTaskID returns `t_YYYYMMDD_NNN` where NNN is one greater
// than the highest existing id under the same date prefix. Mirrors the
// TS generator: UTC date + zero-padded three-digit suffix.
func GenerateTaskID(now time.Time, existing []string) string {
	now = now.UTC()
	prefix := fmt.Sprintf("t_%04d%02d%02d_", now.Year(), now.Month(), now.Day())
	max := 0
	for _, id := range existing {
		if len(id) <= len(prefix) || id[:len(prefix)] != prefix {
			continue
		}
		n, err := strconv.Atoi(id[len(prefix):])
		if err == nil && n > max {
			max = n
		}
	}
	// Sort to keep the result deterministic if the caller passes
	// existing in arbitrary order — the algorithm doesn't depend on it
	// but tests appreciate it.
	sort.Strings(existing)
	return fmt.Sprintf("%s%03d", prefix, max+1)
}
