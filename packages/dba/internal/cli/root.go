// internal/cli/root.go
package cli

import (
	"os"

	"github.com/spf13/cobra"
)

var (
	// Global flags
	flagJSON    bool
	flagVerbose bool
)

var rootCmd = &cobra.Command{
	Use:   "dba",
	Short: "DevBox Agent - Cloud VMs for development",
	Long: `DBA (DevBox Agent) manages cloud VMs for development.

Quick start:
  dba auth login                 # Authenticate
  dba start ./my-project         # Create VM, sync directory → returns ID
  dba code <id>                  # Open VS Code
  dba ssh <id>                   # SSH into VM
  dba sync <id> ./my-project     # Sync files to VM
  dba pause <id>                 # Pause VM (preserves state)
  dba resume <id>                # Resume paused VM
  dba delete <id>                # Delete VM
  dba ls                         # List all VMs`,
	// Silence usage and errors - we handle our own error output
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	// Global flags available to all commands
	rootCmd.PersistentFlags().BoolVar(&flagJSON, "json", false, "Output as JSON")
	rootCmd.PersistentFlags().BoolVarP(&flagVerbose, "verbose", "v", false, "Verbose output")

	// Version command
	rootCmd.AddCommand(versionCmd)

	// Auth commands
	rootCmd.AddCommand(authCmd)
}

// Execute runs the root command
func Execute() error {
	return rootCmd.Execute()
}

// Helper to check if output is a terminal
func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}
