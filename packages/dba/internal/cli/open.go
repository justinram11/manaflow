// internal/cli/open.go
package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/dba-cli/dba/internal/auth"
	"github.com/dba-cli/dba/internal/vm"
	"github.com/spf13/cobra"
)

var codeCmd = &cobra.Command{
	Use:   "code <id>",
	Short: "Open VS Code in browser",
	Long: `Open VS Code for a VM in your browser.

Examples:
  dba code dba_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		instanceID := args[0]

		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		instance, err := client.GetInstance(ctx, instanceID)
		if err != nil {
			return fmt.Errorf("failed to get instance: %w", err)
		}

		if instance.VSCodeURL == "" {
			return fmt.Errorf("VS Code URL not available")
		}

		fmt.Printf("Opening VS Code: %s\n", instance.VSCodeURL)
		return openBrowser(instance.VSCodeURL)
	},
}

var vncCmd = &cobra.Command{
	Use:   "vnc <id>",
	Short: "Open VNC desktop in browser",
	Long: `Open VNC desktop for a VM in your browser.

Examples:
  dba vnc dba_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		instanceID := args[0]

		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		instance, err := client.GetInstance(ctx, instanceID)
		if err != nil {
			return fmt.Errorf("failed to get instance: %w", err)
		}

		if instance.VNCURL == "" {
			return fmt.Errorf("VNC URL not available")
		}

		fmt.Printf("Opening VNC: %s\n", instance.VNCURL)
		return openBrowser(instance.VNCURL)
	},
}

var sshCmd = &cobra.Command{
	Use:   "ssh <id>",
	Short: "SSH into a VM",
	Long: `SSH into a VM.

Examples:
  dba ssh dba_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		instanceID := args[0]

		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		sshCommand, err := client.GetSSHCredentials(ctx, instanceID)
		if err != nil {
			return fmt.Errorf("failed to get SSH credentials: %w", err)
		}

		fmt.Printf("Connecting: %s\n", sshCommand)

		// Parse SSH command: "ssh token@ssh.cloud.morph.so"
		parts := strings.Fields(sshCommand)
		if len(parts) < 2 {
			return fmt.Errorf("invalid SSH command format")
		}

		sshExec := exec.Command("ssh",
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			parts[1],
		)
		sshExec.Stdin = os.Stdin
		sshExec.Stdout = os.Stdout
		sshExec.Stderr = os.Stderr

		return sshExec.Run()
	},
}

var statusCmd = &cobra.Command{
	Use:   "status <id>",
	Short: "Show VM status",
	Long: `Show the status of a VM.

Examples:
  dba status dba_abc123`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		instanceID := args[0]

		teamSlug, err := auth.GetTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client, err := vm.NewClient()
		if err != nil {
			return fmt.Errorf("failed to create client: %w", err)
		}
		client.SetTeamSlug(teamSlug)

		instance, err := client.GetInstance(ctx, instanceID)
		if err != nil {
			return fmt.Errorf("failed to get instance: %w", err)
		}

		fmt.Printf("ID:       %s\n", instance.ID)
		fmt.Printf("Status:   %s\n", instance.Status)
		if instance.VSCodeURL != "" {
			fmt.Printf("VS Code:  %s\n", instance.VSCodeURL)
		}
		if instance.VNCURL != "" {
			fmt.Printf("VNC:      %s\n", instance.VNCURL)
		}

		return nil
	},
}

func openBrowser(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		return fmt.Errorf("unsupported platform")
	}

	return cmd.Start()
}

func init() {
	rootCmd.AddCommand(codeCmd)
	rootCmd.AddCommand(vncCmd)
	rootCmd.AddCommand(sshCmd)
	rootCmd.AddCommand(statusCmd)
}
