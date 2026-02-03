package cli

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Rsync flags - set by sync.go before calling runRsyncOverWebSocket
var (
	rsyncFlagDelete   bool
	rsyncFlagDryRun   bool
	rsyncFlagVerbose  bool
	rsyncFlagExclude  []string
	rsyncFlagParallel int // Number of parallel rsync processes
)

const (
	maxParallelism      = 8  // Max parallel SSH connections
	minFilesForParallel = 50 // Min files before using parallel sync
)

// runRsyncOverWebSocket syncs files using rsync over a WebSocket SSH tunnel
func runRsyncOverWebSocket(workerURL, token, localPath, remotePath string) error {
	// Check for rsync
	if _, err := exec.LookPath("rsync"); err != nil {
		return fmt.Errorf("rsync not found. Install with: brew install rsync (macOS) or apt install rsync (Linux)")
	}

	// Check for sshpass
	if _, err := exec.LookPath("sshpass"); err != nil {
		return fmt.Errorf("sshpass not found. Install with: brew install sshpass (macOS) or apt install sshpass (Linux)")
	}

	// Count total files to determine parallelism
	totalFiles := countFiles(localPath)

	// Get list of top-level entries for parallel sync
	entries, err := os.ReadDir(localPath)
	if err != nil {
		return fmt.Errorf("failed to read directory: %w", err)
	}

	// Filter out excluded entries
	var syncEntries []string
	for _, entry := range entries {
		name := entry.Name()
		if shouldExcludeEntry(name) {
			continue
		}
		syncEntries = append(syncEntries, name)
	}

	if len(syncEntries) == 0 {
		fmt.Println("No files to sync")
		return nil
	}

	// Determine parallelism based on file count
	// More files = more parallel streams (up to max)
	parallelism := rsyncFlagParallel
	if parallelism <= 0 {
		// Auto-determine based on file count
		if totalFiles < minFilesForParallel {
			parallelism = 1
		} else if totalFiles < 500 {
			parallelism = 2
		} else if totalFiles < 2000 {
			parallelism = 4
		} else if totalFiles < 5000 {
			parallelism = 6
		} else {
			parallelism = maxParallelism
		}
	}

	// Can't have more parallel streams than top-level entries
	if parallelism > len(syncEntries) {
		parallelism = len(syncEntries)
	}

	// For small syncs or single stream, just use single rsync
	if parallelism == 1 {
		startTime := time.Now()
		stats, err := runSingleRsync(workerURL, token, localPath, remotePath, nil)
		if err != nil {
			return err
		}
		elapsed := time.Since(startTime)
		if stats != nil && stats.bytes > 0 {
			speedMBps := float64(stats.bytes) / elapsed.Seconds() / 1024 / 1024
			fmt.Printf("✓ Synced %d files (%.1f MB) in %.1fs (%.1f MB/s)\n",
				stats.files, float64(stats.bytes)/1024/1024, elapsed.Seconds(), speedMBps)
		} else {
			fmt.Println("✓ Sync complete")
		}
		return nil
	}

	// Split entries into chunks for parallel processing
	chunks := splitEntries(syncEntries, parallelism)

	fmt.Printf("Syncing %d files in %d parallel streams...\n", totalFiles, len(chunks))

	// Run parallel rsync processes
	var wg sync.WaitGroup
	results := make(chan rsyncResult, len(chunks))

	startTime := time.Now()

	for i, chunk := range chunks {
		wg.Add(1)
		go func(workerID int, items []string) {
			defer wg.Done()
			result := rsyncResult{workerID: workerID}

			// Run rsync for this chunk
			stats, err := runSingleRsync(workerURL, token, localPath, remotePath, items)
			if err != nil {
				result.err = err
			} else {
				result.stats = stats
			}
			results <- result
		}(i, chunk)
	}

	// Wait for all to complete
	go func() {
		wg.Wait()
		close(results)
	}()

	// Collect results
	var syncedFiles, totalBytes int64
	var errors []error
	for result := range results {
		if result.err != nil {
			errors = append(errors, result.err)
		} else if result.stats != nil {
			syncedFiles += result.stats.files
			totalBytes += result.stats.bytes
		}
	}

	elapsed := time.Since(startTime)

	if len(errors) > 0 {
		for _, err := range errors {
			fmt.Printf("  Error: %v\n", err)
		}
		return fmt.Errorf("%d parallel sync(s) failed", len(errors))
	}

	// Print summary
	speedMBps := float64(totalBytes) / elapsed.Seconds() / 1024 / 1024
	fmt.Printf("✓ Synced %d files (%.1f MB) in %.1fs (%.1f MB/s)\n",
		syncedFiles, float64(totalBytes)/1024/1024, elapsed.Seconds(), speedMBps)

	return nil
}

type rsyncResult struct {
	workerID int
	stats    *rsyncStats
	err      error
}

type rsyncStats struct {
	files int64
	bytes int64
}

// countFiles quickly counts files in a directory (for parallelism decision)
func countFiles(dir string) int {
	count := 0
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		// Skip excluded directories
		if d.IsDir() && shouldExcludeEntry(name) {
			return filepath.SkipDir
		}
		if !d.IsDir() && !shouldExcludeEntry(name) {
			count++
		}
		return nil
	})
	return count
}

func shouldExcludeEntry(name string) bool {
	excludes := []string{
		"node_modules",
		".git",
		".venv",
		"__pycache__",
		".DS_Store",
		".env",
		"dist",
		"build",
	}
	excludes = append(excludes, rsyncFlagExclude...)

	for _, ex := range excludes {
		if name == ex {
			return true
		}
		if strings.HasPrefix(ex, "*") && strings.HasSuffix(name, ex[1:]) {
			return true
		}
	}
	return false
}

func splitEntries(entries []string, n int) [][]string {
	chunks := make([][]string, n)
	for i, entry := range entries {
		chunks[i%n] = append(chunks[i%n], entry)
	}
	// Remove empty chunks
	var result [][]string
	for _, chunk := range chunks {
		if len(chunk) > 0 {
			result = append(result, chunk)
		}
	}
	return result
}

// runSingleRsync runs a single rsync process, optionally for specific items only
func runSingleRsync(workerURL, token, localPath, remotePath string, items []string) (*rsyncStats, error) {
	// Convert HTTP URL to WebSocket URL
	wsURL := strings.Replace(workerURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	wsURL = wsURL + "/ssh?token=" + url.QueryEscape(token)

	// Create a local TCP listener that will proxy to the WebSocket
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("failed to create local listener: %w", err)
	}
	defer listener.Close()

	localPort := listener.Addr().(*net.TCPAddr).Port

	// Accept one connection for rsync
	connCh := make(chan net.Conn, 1)
	errCh := make(chan error, 1)

	go func() {
		conn, err := listener.Accept()
		if err != nil {
			errCh <- err
			return
		}
		connCh <- conn
	}()

	// Build rsync command
	rsyncArgs := []string{
		"-az",
		"--stats",
	}

	if rsyncFlagDelete {
		rsyncArgs = append(rsyncArgs, "--delete")
	}
	if rsyncFlagDryRun {
		rsyncArgs = append(rsyncArgs, "-n")
	}

	// Add excludes
	defaultExcludes := []string{
		"node_modules",
		".git",
		".venv",
		"__pycache__",
		".DS_Store",
		"*.pyc",
		".env",
		"dist",
		"build",
	}
	for _, ex := range defaultExcludes {
		rsyncArgs = append(rsyncArgs, "--exclude", ex)
	}
	for _, ex := range rsyncFlagExclude {
		rsyncArgs = append(rsyncArgs, "--exclude", ex)
	}

	// SSH command
	sshCmd := fmt.Sprintf("sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p %d", localPort)
	rsyncArgs = append(rsyncArgs, "-e", sshCmd)

	// Source path(s)
	if items == nil {
		// Sync entire directory
		srcPath := localPath
		if !strings.HasSuffix(srcPath, "/") {
			srcPath = srcPath + "/"
		}
		rsyncArgs = append(rsyncArgs, srcPath)
	} else {
		// Sync specific items using --include/--exclude
		for _, item := range items {
			itemPath := filepath.Join(localPath, item)
			info, err := os.Stat(itemPath)
			if err != nil {
				continue
			}
			if info.IsDir() {
				rsyncArgs = append(rsyncArgs, "--include", item+"/***")
			} else {
				rsyncArgs = append(rsyncArgs, "--include", item)
			}
		}
		rsyncArgs = append(rsyncArgs, "--exclude", "*")
		srcPath := localPath
		if !strings.HasSuffix(srcPath, "/") {
			srcPath = srcPath + "/"
		}
		rsyncArgs = append(rsyncArgs, srcPath)
	}

	// Remote destination
	remoteSpec := fmt.Sprintf("user@127.0.0.1:%s/", remotePath)
	rsyncArgs = append(rsyncArgs, remoteSpec)

	// Start rsync
	rsyncExec := exec.Command("rsync", rsyncArgs...)

	// Capture output for stats parsing
	var stdout, stderr bytes.Buffer
	rsyncExec.Stdout = &stdout
	rsyncExec.Stderr = &stderr
	rsyncExec.Env = append(os.Environ(), "SSHPASS="+token)

	if err := rsyncExec.Start(); err != nil {
		return nil, fmt.Errorf("failed to start rsync: %w", err)
	}

	// Wait for connection from rsync
	var conn net.Conn
	select {
	case conn = <-connCh:
		// Got connection
	case err := <-errCh:
		rsyncExec.Process.Kill()
		return nil, fmt.Errorf("failed to accept connection: %w", err)
	case <-time.After(30 * time.Second):
		rsyncExec.Process.Kill()
		return nil, fmt.Errorf("timeout waiting for rsync connection")
	}

	// Bridge to WebSocket
	proxyDone := make(chan error, 1)
	go func() {
		err := bridgeToWebSocket(conn, wsURL)
		proxyDone <- err
	}()

	// Wait for rsync to complete
	rsyncErr := rsyncExec.Wait()
	conn.Close()
	<-proxyDone

	if rsyncErr != nil {
		if stderr.Len() > 0 {
			return nil, fmt.Errorf("rsync failed: %s", stderr.String())
		}
		return nil, fmt.Errorf("rsync failed: %w", rsyncErr)
	}

	// Parse stats from output
	stats := parseRsyncStats(stdout.String())
	return stats, nil
}

var (
	// Match both GNU rsync and openrsync (macOS) formats
	filesTransferredRe = regexp.MustCompile(`Number of (?:regular )?files transferred:\s*(\d+)`)
	totalBytesRe       = regexp.MustCompile(`Total transferred file size:\s*([\d,]+)\s*(?:B|bytes)?`)
)

func parseRsyncStats(output string) *rsyncStats {
	stats := &rsyncStats{}

	if match := filesTransferredRe.FindStringSubmatch(output); len(match) > 1 {
		stats.files, _ = strconv.ParseInt(match[1], 10, 64)
	}

	if match := totalBytesRe.FindStringSubmatch(output); len(match) > 1 {
		// Remove commas and parse
		bytesStr := strings.ReplaceAll(match[1], ",", "")
		stats.bytes, _ = strconv.ParseInt(bytesStr, 10, 64)
	}

	return stats
}

func bridgeToWebSocket(conn net.Conn, wsURL string) error {
	defer conn.Close()

	// Buffer to hold TCP data that arrives before WebSocket is connected
	var pendingData [][]byte
	var pendingMu sync.Mutex
	wsReady := false

	// Start reading from TCP immediately
	tcpDataCh := make(chan []byte, 100)
	tcpErrCh := make(chan error, 1)

	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				tcpErrCh <- err
				return
			}
			data := make([]byte, n)
			copy(data, buf[:n])
			tcpDataCh <- data
		}
	}()

	// Connect to WebSocket
	dialer := websocket.Dialer{
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: false,
	}

	wsConn, _, err := dialer.Dial(wsURL, http.Header{})
	if err != nil {
		return fmt.Errorf("WebSocket connect failed: %w", err)
	}
	defer wsConn.Close()

	// Flush pending data
	pendingMu.Lock()
	wsReady = true
	for _, data := range pendingData {
		if err := wsConn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			pendingMu.Unlock()
			return fmt.Errorf("failed to send pending data: %w", err)
		}
	}
	pendingData = nil
	pendingMu.Unlock()

	// Bridge TCP <-> WebSocket
	done := make(chan struct{})

	go func() {
		defer close(done)
		for {
			select {
			case data := <-tcpDataCh:
				pendingMu.Lock()
				if wsReady {
					pendingMu.Unlock()
					if err := wsConn.WriteMessage(websocket.BinaryMessage, data); err != nil {
						return
					}
				} else {
					pendingData = append(pendingData, data)
					pendingMu.Unlock()
				}
			case err := <-tcpErrCh:
				if err != io.EOF {
					// Ignore
				}
				wsConn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
		}
	}()

	go func() {
		for {
			messageType, data, err := wsConn.ReadMessage()
			if err != nil {
				conn.Close()
				return
			}
			if messageType == websocket.BinaryMessage || messageType == websocket.TextMessage {
				if _, err := conn.Write(data); err != nil {
					return
				}
			}
		}
	}()

	<-done
	return nil
}
