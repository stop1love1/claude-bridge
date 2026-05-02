// Package git wraps the per-app git lifecycle hook: honor branchMode
// (current / fixed / auto-create) before a child runs, then optionally
// run git add/commit/push afterwards per the app's autoCommit /
// autoPush flags. Failures are logged but never flip a successful run
// to failed.
package git
