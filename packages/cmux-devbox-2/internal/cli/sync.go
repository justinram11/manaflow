package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/cmux-cli/cmux-devbox-2/internal/api"
	"github.com/spf13/cobra"
)

var (
	syncFlagWatch   bool
	syncFlagDelete  bool
	syncFlagExclude []string
	syncFlagDryRun  bool
	syncFlagVerbose bool
)

var syncCmd = &cobra.Command{
	Use:   "sync <id> [local-path] [remote-path]",
	Short: "Sync files to sandbox using rsync",
	Long: `Sync files from a local directory to the sandbox using rsync over WebSocket SSH.
This provides efficient incremental file transfers.

The remote path defaults to /home/user/workspace if not specified.

Prerequisites: rsync must be installed locally.
  macOS:   brew install rsync
  Ubuntu:  apt install rsync

Examples:
  cmux sync cmux_abc123 .                    # Sync current dir to workspace
  cmux sync cmux_abc123 ./src /home/user/app # Sync to specific remote path
  cmux sync cmux_abc123 . --delete           # Sync and delete extra files
  cmux sync cmux_abc123 . -n                 # Dry run (show what would sync)
  cmux sync cmux_abc123 . --watch            # Watch and sync on changes`,
	Args: cobra.RangeArgs(1, 3),
	RunE: func(cmd *cobra.Command, args []string) error {
		teamSlug, err := getTeamSlug()
		if err != nil {
			return fmt.Errorf("failed to get team: %w", err)
		}

		sandboxID := args[0]
		localPath := "."
		if len(args) > 1 {
			localPath = args[1]
		}
		remotePath := "/home/user/workspace"
		if len(args) > 2 {
			remotePath = args[2]
		}

		// Get absolute path
		absPath, err := filepath.Abs(localPath)
		if err != nil {
			return fmt.Errorf("invalid path: %w", err)
		}

		// Check if path exists
		info, err := os.Stat(absPath)
		if err != nil {
			return fmt.Errorf("path not found: %w", err)
		}

		isFile := !info.IsDir()

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

		// Copy flags to rsync flags
		rsyncFlagDelete = syncFlagDelete
		rsyncFlagDryRun = syncFlagDryRun
		rsyncFlagVerbose = syncFlagVerbose
		rsyncFlagExclude = syncFlagExclude

		if isFile {
			// Single file sync
			if syncFlagWatch {
				return fmt.Errorf("--watch is not supported for single file sync")
			}
			fmt.Printf("Syncing file %s to %s:%s via rsync...\n", absPath, sandboxID, remotePath)
			return runRsyncSingleFile(inst.WorkerURL, token, absPath, remotePath)
		}

		if syncFlagWatch {
			return watchAndRsync(inst.WorkerURL, token, absPath, remotePath)
		}

		fmt.Printf("Syncing %s to %s:%s via rsync...\n", absPath, sandboxID, remotePath)
		return runRsyncOverWebSocket(inst.WorkerURL, token, absPath, remotePath)
	},
}

func watchAndRsync(workerURL, token, localPath, remotePath string) error {
	fmt.Printf("Watching %s for changes (Ctrl+C to stop)...\n", localPath)
	fmt.Println("Note: Using fswatch-based polling. Press Ctrl+C to stop.")

	// Initial sync
	fmt.Println("Initial sync...")
	if err := runRsyncOverWebSocket(workerURL, token, localPath, remotePath); err != nil {
		fmt.Printf("Initial sync error: %v\n", err)
	}

	// Use fswatch if available, otherwise poll
	return watchWithPolling(workerURL, token, localPath, remotePath)
}

func watchWithPolling(workerURL, token, localPath, remotePath string) error {
	fmt.Println("Polling for changes every 2 seconds...")

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		// Run rsync (it's incremental, so only changed files transfer)
		if err := runRsyncOverWebSocket(workerURL, token, localPath, remotePath); err != nil {
			fmt.Printf("Sync error: %v\n", err)
		}
	}
	return nil
}

func init() {
	syncCmd.Flags().BoolVarP(&syncFlagWatch, "watch", "w", false, "Watch for changes and sync continuously")
	syncCmd.Flags().BoolVar(&syncFlagDelete, "delete", false, "Delete remote files not present locally")
	syncCmd.Flags().StringSliceVarP(&syncFlagExclude, "exclude", "e", nil, "Patterns to exclude")
	syncCmd.Flags().BoolVarP(&syncFlagDryRun, "dry-run", "n", false, "Perform a trial run with no changes made")
	syncCmd.Flags().BoolVarP(&syncFlagVerbose, "verbose", "v", false, "Increase verbosity")
}
