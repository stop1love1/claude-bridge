// Command fake-claude is a stand-in for the real `claude` CLI used by
// spawn engine tests (S07+). The real binary streams a `session: <uuid>`
// line followed by assistant output and exits when the prompt is done.
// The fake mirrors that handshake without doing any model work so the
// spawn package can assert the registry captures the session id, the
// log file is appended, and process kill is clean.
//
// Flags (only the ones spawn tests need):
//
//	--session <id>      session id to print (default "abc-123")
//	--session-id <id>   alias accepted by the real claude binary; if
//	                    set, takes precedence over --session
//	--exit-code <n>     exit with this code after printing (default 0)
//	--sleep <ms>        sleep before exiting; lets kill tests interrupt
//
// Every other flag the real claude understands (`--output-format`,
// `--verbose`, `--include-partial-messages`, `--settings`, `--effort`,
// `--model`, `--permission-mode`, `--disallowed-tools`, `-p`, etc.) is
// silently consumed. We hand-parse os.Args because flag.Parse rejects
// unknown flags with exit code 2 — the bridge passes a long list of
// real-claude flags that the fake doesn't care about.
package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

func main() {
	session := "abc-123"
	exitCode := 0
	sleepMs := 0

	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--session", "--session-id":
			if i+1 < len(args) {
				session = args[i+1]
				i++
			}
		case "--exit-code":
			if i+1 < len(args) {
				if n, err := strconv.Atoi(args[i+1]); err == nil {
					exitCode = n
				}
				i++
			}
		case "--sleep":
			if i+1 < len(args) {
				if n, err := strconv.Atoi(args[i+1]); err == nil {
					sleepMs = n
				}
				i++
			}
		default:
			// Skip the value for known multi-arg flags so we don't
			// accidentally re-parse it as another flag. We special-case
			// the ones the bridge actually emits; anything else falls
			// through and is ignored.
			switch args[i] {
			case "--output-format", "--settings", "--model", "--effort",
				"--permission-mode", "--disallowed-tools":
				if i+1 < len(args) {
					i++
				}
			}
		}
	}

	fmt.Printf("session: %s\n", session)
	fmt.Println("hello")

	if sleepMs > 0 {
		time.Sleep(time.Duration(sleepMs) * time.Millisecond)
	}
	os.Exit(exitCode)
}
