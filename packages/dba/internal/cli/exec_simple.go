// internal/cli/exec_simple.go
package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dba-cli/dba/internal/auth"
	"github.com/dba-cli/dba/internal/vm"
	"github.com/spf13/cobra"
)

var execCmd = &cobra.Command{
	Use:   "exec <id> <command>",
	Short: "Execute a command in a VM",
	Long: `Execute a command in a VM.

Examples:
  dba exec dba_abc123 "ls -la"
  dba exec dba_abc123 "npm install"
  dba exec dba_abc123 "cat /etc/os-release"`,
	Args: cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		instanceID := args[0]
		command := strings.Join(args[1:], " ")

		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		stdout, stderr, exitCode, err := client.ExecCommand(ctx, instanceID, command)
		if err != nil {
			return fmt.Errorf("failed to execute command: %w", err)
		}

		if stdout != "" {
			fmt.Print(stdout)
		}
		if stderr != "" {
			fmt.Print(stderr)
		}

		if exitCode != 0 {
			return fmt.Errorf("command exited with code %d", exitCode)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(execCmd)
}
