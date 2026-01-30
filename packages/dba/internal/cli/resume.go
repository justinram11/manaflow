// internal/cli/resume.go
package cli

import (
	"context"
	"fmt"
	"time"

	"github.com/dba-cli/dba/internal/auth"
	"github.com/dba-cli/dba/internal/state"
	"github.com/dba-cli/dba/internal/vm"
	"github.com/spf13/cobra"
)

var resumeCmd = &cobra.Command{
	Use:   "resume <id>",
	Short: "Resume a paused VM",
	Long: `Resume a paused VM by its ID.

Examples:
  dba resume dba_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		instanceID := args[0]

		// Get team slug
		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		fmt.Printf("Resuming VM %s...\n", instanceID)
		if err := client.ResumeInstance(ctx, instanceID); err != nil {
			return fmt.Errorf("failed to resume VM: %w", err)
		}

		// Wait for ready
		fmt.Println("Waiting for VM to be ready...")
		instance, err := client.WaitForReady(ctx, instanceID, 2*time.Minute)
		if err != nil {
			return fmt.Errorf("VM failed to resume: %w", err)
		}

		// Save as last used
		state.SetLastInstance(instanceID, teamSlug)

		fmt.Println("\n✓ VM resumed!")
		fmt.Printf("  ID:       %s\n", instance.ID)
		fmt.Printf("  VS Code:  %s\n", instance.VSCodeURL)
		fmt.Printf("  VNC:      %s\n", instance.VNCURL)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(resumeCmd)
}
