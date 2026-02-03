package cli

import (
	"encoding/json"
	"fmt"

	"github.com/cmux-cli/cmux-devbox-2/internal/api"
	"github.com/spf13/cobra"
)

var (
	startFlagName     string
	startFlagTemplate string
	startFlagOpen     bool
)

var startCmd = &cobra.Command{
	Use:     "start",
	Aliases: []string{"create", "new"},
	Short:   "Create a new E2B sandbox",
	RunE: func(cmd *cobra.Command, args []string) error {
		teamSlug, err := getTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client := api.NewClient()
		resp, err := client.CreateInstance(teamSlug, startFlagTemplate, startFlagName)
		if err != nil {
			return err
		}

		if flagJSON {
			data, _ := json.MarshalIndent(resp, "", "  ")
			fmt.Println(string(data))
		} else {
			fmt.Printf("Created sandbox: %s\n", resp.DevboxID)
			fmt.Printf("  Status: %s\n", resp.Status)
			if resp.VSCodeURL != "" {
				fmt.Printf("  VSCode: %s\n", resp.VSCodeURL)
			}
			if resp.VNCURL != "" {
				fmt.Printf("  VNC:    %s\n", resp.VNCURL)
			}
			if resp.E2BInstanceID != "" {
				fmt.Printf("  E2B ID: %s\n", resp.E2BInstanceID)
			}
		}

		if startFlagOpen && resp.VSCodeURL != "" {
			fmt.Println("\nOpening VSCode...")
			openURL(resp.VSCodeURL)
		}

		return nil
	},
}

func init() {
	startCmd.Flags().StringVarP(&startFlagName, "name", "n", "", "Name for the sandbox")
	startCmd.Flags().StringVarP(&startFlagTemplate, "template", "T", "", "E2B template ID")
	startCmd.Flags().BoolVarP(&startFlagOpen, "open", "o", false, "Open VSCode after creation")
}
