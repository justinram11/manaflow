package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cmux-cli/cmux-devbox-2/internal/api"
	"github.com/spf13/cobra"
)

var uploadCmd = &cobra.Command{
	Use:   "upload <local-file> <id>:<remote-path>",
	Short: "Upload a file to sandbox",
	Long: `Upload a single file to a sandbox instance.

The destination uses scp-like syntax: <sandbox-id>:<remote-path>
If the remote path ends with /, the file is uploaded into that directory
with its original name.

Examples:
  cmux upload ./config.json cmux_abc123:/home/user/app/
  cmux upload ./script.sh cmux_abc123:/home/user/bin/script.sh
  cmux upload data.csv cmux_abc123:/home/user/workspace/`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		localFile := args[0]
		dest := args[1]

		// Parse destination (id:path format)
		parts := strings.SplitN(dest, ":", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid destination format, expected <id>:<remote-path>")
		}
		sandboxID := parts[0]
		remotePath := parts[1]

		if sandboxID == "" {
			return fmt.Errorf("sandbox ID cannot be empty")
		}
		if remotePath == "" {
			return fmt.Errorf("remote path cannot be empty")
		}

		// Get absolute path for local file
		absPath, err := filepath.Abs(localFile)
		if err != nil {
			return fmt.Errorf("invalid path: %w", err)
		}

		// Check if local file exists and is a file
		info, err := os.Stat(absPath)
		if err != nil {
			return fmt.Errorf("file not found: %w", err)
		}
		if info.IsDir() {
			return fmt.Errorf("path is a directory, use 'cmux sync' for directories")
		}

		// If remote path ends with /, append the filename
		if strings.HasSuffix(remotePath, "/") {
			remotePath = remotePath + filepath.Base(absPath)
		}

		teamSlug, err := getTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		client := api.NewClient()

		// Get sandbox info
		inst, err := client.GetInstance(teamSlug, sandboxID)
		if err != nil {
			return fmt.Errorf("sandbox not found: %w", err)
		}

		if inst.WorkerURL == "" {
			return fmt.Errorf("worker URL not available")
		}

		// Get auth token
		token, err := client.GetAuthToken(teamSlug, sandboxID)
		if err != nil {
			return fmt.Errorf("failed to get auth token: %w", err)
		}

		// Reset rsync flags (don't inherit from sync command)
		rsyncFlagDelete = false
		rsyncFlagDryRun = false
		rsyncFlagVerbose = false
		rsyncFlagExclude = nil

		fmt.Printf("Uploading %s to %s:%s...\n", filepath.Base(absPath), sandboxID, remotePath)
		return runRsyncSingleFile(inst.WorkerURL, token, absPath, remotePath)
	},
}
