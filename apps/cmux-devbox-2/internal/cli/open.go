package cli

import (
	"fmt"
	"os/exec"
	"runtime"

	"github.com/cmux-cli/cmux-devbox-2/internal/api"
	"github.com/spf13/cobra"
)

var openFlagVNC bool

var openCmd = &cobra.Command{
	Use:   "open <id>",
	Short: "Open sandbox in browser (VSCode or VNC)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		teamSlug, err := getTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client := api.NewClient()
		inst, err := client.GetInstance(teamSlug, args[0])
		if err != nil {
			return err
		}

		var url string
		if openFlagVNC {
			url = inst.VNCURL
			if url == "" {
				return fmt.Errorf("no VNC URL available for this sandbox")
			}
		} else {
			url = inst.VSCodeURL
			if url == "" {
				return fmt.Errorf("no VSCode URL available for this sandbox")
			}
		}

		fmt.Printf("Opening: %s\n", url)
		return openURL(url)
	},
}

func init() {
	openCmd.Flags().BoolVar(&openFlagVNC, "vnc", false, "Open VNC instead of VSCode")
}

func openURL(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return fmt.Errorf("unsupported platform")
	}
	return cmd.Start()
}
