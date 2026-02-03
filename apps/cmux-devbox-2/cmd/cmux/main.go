package main

import (
	"fmt"
	"os"

	"github.com/cmux-cli/cmux-devbox-2/internal/auth"
	"github.com/cmux-cli/cmux-devbox-2/internal/cli"
)

// Build-time variables set via ldflags
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
	Mode      = "dev" // "dev" or "prod"
)

func main() {
	cli.SetVersionInfo(Version, Commit, BuildTime)
	cli.SetBuildMode(Mode)
	auth.SetBuildMode(Mode)

	if os.Getenv("CMUX_E2B_DEV") == "" && os.Getenv("CMUX_E2B_PROD") == "" {
		if Mode == "dev" {
			os.Setenv("CMUX_E2B_DEV", "1")
		}
	}

	if err := cli.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
