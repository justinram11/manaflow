package cli

import (
	"github.com/cmux-cli/cmux-devbox-2/internal/auth"
	"github.com/spf13/cobra"
)

var (
	flagJSON    bool
	flagVerbose bool
	flagTeam    string
)

var rootCmd = &cobra.Command{
	Use:   "cmux",
	Short: "cmux - Cloud sandboxes for development",
	Long:  `cmux manages cloud sandboxes for development.

Quick start:
  cmux login                      # Authenticate (or: cmux auth login)
  cmux start ./my-project         # Create sandbox, sync directory → returns ID
  cmux code <id>                  # Open VS Code
  cmux pty <id>                   # Open terminal session
  cmux sync <id> ./my-project     # Sync files via rsync (incremental)
  cmux computer screenshot <id>   # Take browser screenshot
  cmux stop <id>                  # Stop sandbox
  cmux delete <id>                # Delete sandbox
  cmux ls                         # List all sandboxes`,
	SilenceUsage:  true,
	SilenceErrors: true,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		auth.SetConfigOverrides("", "", "", "")
	},
}

func init() {
	rootCmd.PersistentFlags().BoolVar(&flagJSON, "json", false, "Output as JSON")
	rootCmd.PersistentFlags().BoolVarP(&flagVerbose, "verbose", "v", false, "Verbose output")
	rootCmd.PersistentFlags().StringVarP(&flagTeam, "team", "t", "", "Team slug (overrides default)")

	// Version command
	rootCmd.AddCommand(versionCmd)

	// Auth commands
	rootCmd.AddCommand(authCmd)
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(logoutCmd)
	rootCmd.AddCommand(whoamiCmd)

	// Instance management
	rootCmd.AddCommand(startCmd)
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(statusCmd)

	// Open commands
	rootCmd.AddCommand(codeCmd)
	rootCmd.AddCommand(vncCmd)

	// Lifecycle commands
	rootCmd.AddCommand(stopCmd)
	rootCmd.AddCommand(deleteCmd)
	rootCmd.AddCommand(extendCmd)
	rootCmd.AddCommand(pauseCmd)
	rootCmd.AddCommand(resumeCmd)

	// Exec command
	rootCmd.AddCommand(execCmd)

	// Sync command (uses rsync over WebSocket SSH)
	rootCmd.AddCommand(syncCmd)

	// PTY command (terminal session)
	rootCmd.AddCommand(ptyCmd)

	// Computer commands (browser automation)
	rootCmd.AddCommand(computerCmd)

	// Templates
	rootCmd.AddCommand(templatesCmd)
}

func Execute() error {
	return rootCmd.Execute()
}

var (
	versionStr   = "dev"
	commitStr    = "unknown"
	buildTimeStr = "unknown"
	buildMode    = "dev"
)

func SetVersionInfo(version, commit, buildTime string) {
	versionStr = version
	commitStr = commit
	buildTimeStr = buildTime
	rootCmd.Version = version
	rootCmd.SetVersionTemplate("cmux version {{.Version}}\n")
}

func SetBuildMode(mode string) {
	buildMode = mode
}

func getTeamSlug() (string, error) {
	if flagTeam != "" {
		return flagTeam, nil
	}
	return auth.GetTeamSlug()
}
