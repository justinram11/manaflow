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
	Short: "cmux - Cloud sandboxes powered by E2B",
	Long: `cmux manages E2B cloud sandboxes with VSCode, VNC, and browser automation.

Quick start:
  cmux login                    # Authenticate
  cmux start --name my-dev      # Create sandbox
  cmux ls                       # List sandboxes
  cmux open <id>                # Open VSCode
  cmux exec <id> "echo hello"   # Run command
  cmux stop <id>                # Stop sandbox`,
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

	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(authCmd)
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(logoutCmd)
	rootCmd.AddCommand(whoamiCmd)
	rootCmd.AddCommand(startCmd)
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(getCmd)
	rootCmd.AddCommand(stopCmd)
	rootCmd.AddCommand(extendCmd)
	rootCmd.AddCommand(pauseCmd)
	rootCmd.AddCommand(resumeCmd)
	rootCmd.AddCommand(execCmd)
	rootCmd.AddCommand(openCmd)
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
