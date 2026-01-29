// cmd/dba/main.go
package main

import (
	"os"

	"github.com/dba-cli/dba/internal/cli"
)

// These are set by the build process
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)

func main() {
	cli.SetVersionInfo(Version, Commit, BuildTime)

	if err := cli.Execute(); err != nil {
		cli.OutputError(err)
		os.Exit(cli.GetExitCode(err))
	}
}
