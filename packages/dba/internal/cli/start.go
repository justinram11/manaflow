// internal/cli/start.go
package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/dba-cli/dba/internal/auth"
	"github.com/dba-cli/dba/internal/state"
	"github.com/dba-cli/dba/internal/vm"
	"github.com/spf13/cobra"
)

var startCmd = &cobra.Command{
	Use:   "start [path]",
	Short: "Create a new VM",
	Long: `Create a new VM and optionally sync a local directory into it.

Each call creates a NEW VM. Use 'dba resume <id>' to resume a paused VM.

Examples:
  dba start                    # Create VM (no sync)
  dba start .                  # Create VM, sync current directory
  dba start ./my-project       # Create VM, sync specific directory
  dba start --snapshot=snap_x  # Create from specific snapshot`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Get team slug
		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w\nRun 'dba auth login' to authenticate", err)
		}

		// Create VM client
		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		// Get snapshot ID
		snapshotID, _ := cmd.Flags().GetString("snapshot")

		// Determine name from path if provided
		name := ""
		var syncPath string
		if len(args) > 0 {
			syncPath = args[0]
			absPath, err := filepath.Abs(syncPath)
			if err != nil {
				return fmt.Errorf("invalid path: %w", err)
			}
			syncPath = absPath

			// Check path exists and is a directory
			info, err := os.Stat(syncPath)
			if err != nil {
				return fmt.Errorf("path not found: %w", err)
			}
			if !info.IsDir() {
				return fmt.Errorf("path must be a directory")
			}
			name = filepath.Base(syncPath)
		}

		fmt.Println("Creating VM...")
		instance, err := client.CreateInstance(ctx, vm.CreateOptions{
			SnapshotID: snapshotID,
			Name:       name,
		})
		if err != nil {
			return fmt.Errorf("failed to create VM: %w", err)
		}

		fmt.Printf("VM created: %s\n", instance.ID)

		// Wait for VM to be ready
		fmt.Println("Waiting for VM to be ready...")
		instance, err = client.WaitForReady(ctx, instance.ID, 2*time.Minute)
		if err != nil {
			return fmt.Errorf("VM failed to start: %w", err)
		}

		// Sync directory if specified
		if syncPath != "" {
			fmt.Printf("Syncing %s to VM...\n", syncPath)
			if err := client.SyncToVM(ctx, instance.ID, syncPath); err != nil {
				fmt.Printf("Warning: failed to sync files: %v\n", err)
			} else {
				fmt.Println("Files synced successfully")
			}
		}

		// Save as last used instance
		state.SetLastInstance(instance.ID, teamSlug)

		// Output results
		fmt.Println("\n✓ VM is ready!")
		fmt.Printf("  ID:       %s\n", instance.ID)
		fmt.Printf("  VS Code:  %s\n", instance.VSCodeURL)
		fmt.Printf("  VNC:      %s\n", instance.VNCURL)

		return nil
	},
}

func init() {
	startCmd.Flags().String("snapshot", "", "Snapshot ID to create from")
	rootCmd.AddCommand(startCmd)
}
