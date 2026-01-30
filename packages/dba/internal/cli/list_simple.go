// internal/cli/list_simple.go
package cli

import (
	"context"
	"fmt"
	"time"

	"github.com/dba-cli/dba/internal/auth"
	"github.com/dba-cli/dba/internal/vm"
	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:     "ls",
	Aliases: []string{"list", "ps"},
	Short:   "List your VMs",
	Long: `List all your VM instances.

Examples:
  dba ls
  dba list`,
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		instances, err := client.ListInstances(ctx)
		if err != nil {
			return fmt.Errorf("failed to list instances: %w", err)
		}

		if len(instances) == 0 {
			fmt.Println("No VMs found. Run 'dba start' to create one.")
			return nil
		}

		fmt.Printf("%-20s %-10s %s\n", "ID", "STATUS", "VS CODE URL")
		fmt.Println("-------------------- ---------- " + "----------------------------------------")

		for _, inst := range instances {
			url := inst.VSCodeURL
			if len(url) > 40 {
				url = url[:40] + "..."
			}
			fmt.Printf("%-20s %-10s %s\n", inst.ID, inst.Status, url)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(listCmd)
}
