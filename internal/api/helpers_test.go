package api_test

import "os"

func readFileOS(p string) ([]byte, error) {
	return os.ReadFile(p)
}
