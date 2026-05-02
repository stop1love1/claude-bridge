// Command fake-claude is a stand-in for the real `claude` CLI used by
// spawn engine tests (lands fully in S07). The real binary streams a
// `session: <uuid>` line followed by assistant output and exits when
// the prompt is done. The fake mirrors that handshake without doing
// any model work so test/spawn can assert the registry captures the
// session id, the log file is appended, and process kill is clean.
//
// Flags (only the ones spawn tests need):
//
//	--session <id>    session id to print (default "abc-123")
//	--exit-code <n>   exit with this code after printing (default 0)
//	--sleep <ms>      sleep before exiting; lets kill tests interrupt
//
// All other args are ignored — the real `claude` accepts a prompt and
// many flags; the fake doesn't care about them.
package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	session := flag.String("session", "abc-123", "session id to emit")
	exitCode := flag.Int("exit-code", 0, "exit code after handshake")
	sleepMs := flag.Int("sleep", 0, "milliseconds to sleep before exiting")
	flag.Parse()

	fmt.Printf("session: %s\n", *session)
	fmt.Println("hello")

	if *sleepMs > 0 {
		time.Sleep(time.Duration(*sleepMs) * time.Millisecond)
	}
	os.Exit(*exitCode)
}
