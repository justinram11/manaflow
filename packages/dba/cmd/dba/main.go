// cmd/dba/main.go
package main

import (
	"fmt"
	"os"

	"github.com/dba-cli/dba/internal/cli"
)

// These are set by the build process
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
	Mode      = "dev" // "dev" or "prod" - set to "prod" for release builds
)

func main() {
	cli.SetVersionInfo(Version, Commit, BuildTime)
	cli.SetBuildMode(Mode)

	// Set DBA_DEV based on build mode if not already set
	// This ensures auth package uses correct config
	if os.Getenv("DBA_DEV") == "" && os.Getenv("DBA_PROD") == "" {
		if Mode == "dev" {
			os.Setenv("DBA_DEV", "1")
		}
	}

	if err := cli.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
