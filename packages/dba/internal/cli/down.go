// internal/cli/down.go
package cli

import (
	"context"
	"fmt"
	"time"

	"github.com/dba-cli/dba/internal/auth"
	"github.com/dba-cli/dba/internal/vm"
	"github.com/spf13/cobra"
)

var deleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a VM",
	Long: `Delete a VM by its ID.

Use 'dba pause <id>' to pause instead (preserves state for resume).

Examples:
  dba delete dba_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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

		fmt.Printf("Deleting VM %s...\n", instanceID)
		if err := client.StopInstance(ctx, instanceID); err != nil {
			return fmt.Errorf("failed to delete VM: %w", err)
		}

		fmt.Println("✓ VM deleted")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(deleteCmd)
}
