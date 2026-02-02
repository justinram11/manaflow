// Package auth provides authentication for the cmux devbox CLI via Stack Auth.
// Credentials are stored in a location compatible with the cmux Rust CLI,
// allowing users to log in once and use both tools.
package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Shared constants - must match cmux Rust CLI for credential sharing
const (
	KeychainService = "cmux"
	ConfigDirName   = "cmux"

	// Stack Auth API
	StackAuthAPIURL = "https://api.stack-auth.com"

	// Dev Stack Auth project
	DevProjectID      = "1467bed0-8522-45ee-a8d8-055de324118c"
	DevPublishableKey = "pck_pt4nwry6sdskews2pxk4g2fbe861ak2zvaf3mqendspa0"
	DevCmuxURL         = "http://localhost:9779"
	DevConvexSiteURL   = "https://famous-camel-162.convex.site" // Dev Convex HTTP site

	// Prod Stack Auth project
	ProdProjectID       = "8a877114-b905-47c5-8b64-3a2d90679577"
	ProdPublishableKey  = "pck_8761mjjmyqc84e1e8ga3rn0k1nkggmggwa3pyzzgntv70"
	ProdCmuxURL         = "https://cmux.sh"
	ProdConvexSiteURL   = "https://adorable-wombat-701.convex.site" // Production Convex HTTP site
)

// Config holds auth configuration
type Config struct {
	ProjectID      string
	PublishableKey string
	CmuxURL        string
	ConvexSiteURL  string
	StackAuthURL   string
	IsDev          bool
}

// GetConfig returns auth configuration based on environment
func GetConfig() Config {
	// Check for environment overrides first
	projectID := os.Getenv("STACK_PROJECT_ID")
	publishableKey := os.Getenv("STACK_PUBLISHABLE_CLIENT_KEY")
	cmuxURL := os.Getenv("CMUX_API_URL")
	convexSiteURL := os.Getenv("CONVEX_SITE_URL")
	stackAuthURL := os.Getenv("AUTH_API_URL")

	if stackAuthURL == "" {
		stackAuthURL = StackAuthAPIURL
	}

	// Dev mode is the default (set CMUX_DEVBOX_PROD=1 to use production)
	isDev := os.Getenv("CMUX_DEVBOX_PROD") != "1" && os.Getenv("CMUX_DEVBOX_PROD") != "true"

	if projectID == "" {
		if isDev {
			projectID = DevProjectID
		} else {
			projectID = ProdProjectID
		}
	}

	if publishableKey == "" {
		if isDev {
			publishableKey = DevPublishableKey
		} else {
			publishableKey = ProdPublishableKey
		}
	}

	if cmuxURL == "" {
		if isDev {
			cmuxURL = DevCmuxURL
		} else {
			cmuxURL = ProdCmuxURL
		}
	}

	if convexSiteURL == "" {
		if isDev {
			convexSiteURL = DevConvexSiteURL
		} else {
			convexSiteURL = ProdConvexSiteURL
		}
	}

	return Config{
		ProjectID:      projectID,
		PublishableKey: publishableKey,
		CmuxURL:        cmuxURL,
		ConvexSiteURL:  convexSiteURL,
		StackAuthURL:   stackAuthURL,
		IsDev:          isDev,
	}
}

// getConfigDir returns the config directory path
func getConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	return filepath.Join(home, ".config", ConfigDirName), nil
}

// getCredentialsPath returns the path to the credentials file
func getCredentialsPath() (string, error) {
	configDir, err := getConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "credentials.json"), nil
}

// getAccessTokenCachePath returns the path to the access token cache file
func getAccessTokenCachePath() (string, error) {
	configDir, err := getConfigDir()
	if err != nil {
		return "", err
	}

	cfg := GetConfig()
	filename := "access_token_cache_prod.json"
	if cfg.IsDev {
		filename = "access_token_cache_dev.json"
	}

	return filepath.Join(configDir, filename), nil
}

// Credentials holds stored auth tokens
type Credentials struct {
	StackRefreshToken string `json:"stack_refresh_token,omitempty"`
	MorphAPIKey       string `json:"morph_api_key,omitempty"`
}

// StoreRefreshToken stores the Stack Auth refresh token
func StoreRefreshToken(token string) error {
	if runtime.GOOS == "darwin" {
		return storeInKeychain(token)
	}
	return storeInFile(token)
}

// GetRefreshToken retrieves the Stack Auth refresh token
func GetRefreshToken() (string, error) {
	if runtime.GOOS == "darwin" {
		return getFromKeychain()
	}
	return getFromFile()
}

// DeleteRefreshToken removes the stored refresh token
func DeleteRefreshToken() error {
	if runtime.GOOS == "darwin" {
		return deleteFromKeychain()
	}
	return deleteFromFile()
}

// macOS Keychain operations
func storeInKeychain(token string) error {
	cfg := GetConfig()
	account := fmt.Sprintf("STACK_REFRESH_TOKEN_%s", cfg.ProjectID)

	// Delete existing entry (ignore errors)
	_ = exec.Command("security", "delete-generic-password",
		"-s", KeychainService,
		"-a", account,
	).Run()

	// Add new entry
	cmd := exec.Command("security", "add-generic-password",
		"-s", KeychainService,
		"-a", account,
		"-w", token,
		"-A", // Allow any application
	)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to store token in keychain: %w", err)
	}
	return nil
}

func getFromKeychain() (string, error) {
	cfg := GetConfig()
	account := fmt.Sprintf("STACK_REFRESH_TOKEN_%s", cfg.ProjectID)

	cmd := exec.Command("security", "find-generic-password",
		"-s", KeychainService,
		"-a", account,
		"-w",
	)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("token not found in keychain")
	}
	return strings.TrimSpace(string(output)), nil
}

func deleteFromKeychain() error {
	cfg := GetConfig()
	account := fmt.Sprintf("STACK_REFRESH_TOKEN_%s", cfg.ProjectID)

	cmd := exec.Command("security", "delete-generic-password",
		"-s", KeychainService,
		"-a", account,
	)
	_ = cmd.Run() // Ignore errors (may not exist)
	return nil
}

// File-based storage for Linux
func storeInFile(token string) error {
	path, err := getCredentialsPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("failed to create config dir: %w", err)
	}

	// Read existing credentials
	creds := Credentials{}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &creds)
	}

	creds.StackRefreshToken = token

	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal credentials: %w", err)
	}

	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write credentials: %w", err)
	}

	return nil
}

func getFromFile() (string, error) {
	path, err := getCredentialsPath()
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("credentials file not found")
	}

	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return "", fmt.Errorf("failed to parse credentials: %w", err)
	}

	if creds.StackRefreshToken == "" {
		return "", fmt.Errorf("no refresh token stored")
	}

	return creds.StackRefreshToken, nil
}

func deleteFromFile() error {
	path, err := getCredentialsPath()
	if err != nil {
		return err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil // File doesn't exist, nothing to delete
	}

	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil
	}

	creds.StackRefreshToken = ""

	newData, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, newData, 0600)
}

// AccessToken represents a cached access token
type AccessToken struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
}

// GetCachedAccessToken returns a valid cached access token if available
func GetCachedAccessToken(minValiditySecs int64) (string, error) {
	path, err := getAccessTokenCachePath()
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("no cached access token")
	}

	var cached AccessToken
	if err := json.Unmarshal(data, &cached); err != nil {
		return "", fmt.Errorf("failed to parse cached token: %w", err)
	}

	now := time.Now().Unix()
	if cached.ExpiresAt-now > minValiditySecs {
		return cached.Token, nil
	}

	return "", fmt.Errorf("cached token expired")
}

// CacheAccessToken stores an access token with its expiry
func CacheAccessToken(token string, expiresAt int64) error {
	path, err := getAccessTokenCachePath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}

	cached := AccessToken{
		Token:     token,
		ExpiresAt: expiresAt,
	}

	data, err := json.Marshal(cached)
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// ClearCachedAccessToken removes the cached access token
func ClearCachedAccessToken() error {
	path, err := getAccessTokenCachePath()
	if err != nil {
		return err
	}
	_ = os.Remove(path)
	return nil
}

// IsLoggedIn checks if the user has stored credentials
func IsLoggedIn() bool {
	_, err := GetRefreshToken()
	return err == nil
}

// CliAuthInitResponse is the response from /api/v1/auth/cli
type CliAuthInitResponse struct {
	PollingCode string `json:"polling_code"`
	LoginCode   string `json:"login_code"`
}

// CliAuthPollResponse is the response from /api/v1/auth/cli/poll
type CliAuthPollResponse struct {
	Status       string `json:"status"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

// RefreshTokenResponse is the response from the refresh token endpoint
type RefreshTokenResponse struct {
	AccessToken string `json:"access_token"`
}

// UserInfo holds basic user information
type UserInfo struct {
	ID           string `json:"id"`
	PrimaryEmail string `json:"primary_email,omitempty"`
	DisplayName  string `json:"display_name,omitempty"`
}

// Login performs the browser-based Stack Auth login flow
func Login() error {
	cfg := GetConfig()

	// Check if already logged in
	if IsLoggedIn() {
		return fmt.Errorf("already logged in. Run 'cmux auth logout' first to re-authenticate")
	}

	fmt.Println("Starting authentication...")

	client := &http.Client{Timeout: 30 * time.Second}

	// Step 1: Initiate CLI auth flow
	initURL := fmt.Sprintf("%s/api/v1/auth/cli", cfg.StackAuthURL)
	initBody := strings.NewReader(`{"expires_in_millis": 600000}`)

	req, err := http.NewRequest("POST", initURL, initBody)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("x-stack-project-id", cfg.ProjectID)
	req.Header.Set("x-stack-publishable-client-key", cfg.PublishableKey)
	req.Header.Set("x-stack-access-type", "client")
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to initiate auth: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to initiate auth: status %d", resp.StatusCode)
	}

	var initResp CliAuthInitResponse
	if err := json.NewDecoder(resp.Body).Decode(&initResp); err != nil {
		return fmt.Errorf("failed to decode init response: %w", err)
	}

	// Step 2: Open browser
	authURL := fmt.Sprintf("%s/handler/cli-auth-confirm?login_code=%s",
		cfg.CmuxURL, initResp.LoginCode)

	fmt.Println("\nOpening browser to complete authentication...")
	fmt.Printf("If browser doesn't open, visit:\n  %s\n\n", authURL)

	if err := openBrowser(authURL); err != nil {
		fmt.Printf("Failed to open browser: %v\n", err)
		fmt.Println("Please open the URL manually.")
	}

	// Step 3: Poll for completion
	fmt.Println("Waiting for authentication... (press Ctrl+C to cancel)")

	pollURL := fmt.Sprintf("%s/api/v1/auth/cli/poll", cfg.StackAuthURL)
	maxAttempts := 120 // 10 minutes at 5 second intervals

	for attempt := 0; attempt < maxAttempts; attempt++ {
		time.Sleep(5 * time.Second)

		pollBody := fmt.Sprintf(`{"polling_code": "%s"}`, initResp.PollingCode)
		req, err := http.NewRequest("POST", pollURL, strings.NewReader(pollBody))
		if err != nil {
			continue
		}

		req.Header.Set("x-stack-project-id", cfg.ProjectID)
		req.Header.Set("x-stack-publishable-client-key", cfg.PublishableKey)
		req.Header.Set("x-stack-access-type", "client")
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			fmt.Print(".")
			continue
		}

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			resp.Body.Close()
			fmt.Print(".")
			continue
		}

		var pollResp CliAuthPollResponse
		if err := json.NewDecoder(resp.Body).Decode(&pollResp); err != nil {
			resp.Body.Close()
			continue
		}
		resp.Body.Close()

		switch pollResp.Status {
		case "success":
			if pollResp.RefreshToken == "" {
				return fmt.Errorf("authentication succeeded but no refresh token returned")
			}

			// Store the refresh token
			if err := StoreRefreshToken(pollResp.RefreshToken); err != nil {
				return fmt.Errorf("failed to store token: %w", err)
			}

			fmt.Println("\n\n✓ Authentication successful!")
			fmt.Println("  Refresh token stored securely.")

			// Fetch and cache user profile (includes team info)
			if profile, err := FetchUserProfile(); err == nil {
				if profile.Email != "" {
					fmt.Printf("  Logged in as: %s\n", profile.Email)
				} else if profile.Name != "" {
					fmt.Printf("  Logged in as: %s\n", profile.Name)
				}
				if profile.TeamDisplayName != "" {
					fmt.Printf("  Team: %s\n", profile.TeamDisplayName)
				} else if profile.TeamSlug != "" {
					fmt.Printf("  Team: %s\n", profile.TeamSlug)
				}
			} else {
				// Fallback to basic user info from Stack Auth
				if userInfo, err := GetUserInfo(); err == nil {
					if userInfo.PrimaryEmail != "" {
						fmt.Printf("  Logged in as: %s\n", userInfo.PrimaryEmail)
					} else if userInfo.DisplayName != "" {
						fmt.Printf("  Logged in as: %s\n", userInfo.DisplayName)
					}
				}
			}

			return nil

		case "expired":
			return fmt.Errorf("authentication expired. Please try again")

		default:
			fmt.Print(".")
		}
	}

	return fmt.Errorf("authentication timed out")
}

// Logout clears stored credentials
func Logout() error {
	if err := DeleteRefreshToken(); err != nil {
		return err
	}
	if err := ClearCachedAccessToken(); err != nil {
		return err
	}
	if err := ClearCachedUserProfile(); err != nil {
		return err
	}
	fmt.Println("✓ Logged out successfully")
	return nil
}

// GetAccessToken returns a valid access token, refreshing if necessary
func GetAccessToken() (string, error) {
	// Try cached token first (with 60 second buffer)
	if token, err := GetCachedAccessToken(60); err == nil {
		return token, nil
	}

	// Need to refresh
	refreshToken, err := GetRefreshToken()
	if err != nil {
		return "", fmt.Errorf("not logged in. Run 'cmux auth login' first")
	}

	cfg := GetConfig()
	client := &http.Client{Timeout: 30 * time.Second}

	// Refresh the token
	refreshURL := fmt.Sprintf("%s/api/v1/auth/sessions/current/refresh", cfg.StackAuthURL)
	req, err := http.NewRequest("POST", refreshURL, nil)
	if err != nil {
		return "", err
	}

	req.Header.Set("x-stack-project-id", cfg.ProjectID)
	req.Header.Set("x-stack-publishable-client-key", cfg.PublishableKey)
	req.Header.Set("x-stack-access-type", "client")
	req.Header.Set("x-stack-refresh-token", refreshToken)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to refresh token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to refresh token: status %d. Try 'cmux auth login' to re-authenticate", resp.StatusCode)
	}

	var refreshResp RefreshTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&refreshResp); err != nil {
		return "", fmt.Errorf("failed to decode refresh response: %w", err)
	}

	// Parse JWT to get expiry (simple extraction, no verification needed)
	expiresAt := time.Now().Add(1 * time.Hour).Unix() // Default 1 hour
	if parts := strings.Split(refreshResp.AccessToken, "."); len(parts) == 3 {
		// Try to parse payload for actual expiry
		// This is best-effort; we'll use default if it fails
	}

	// Cache the new access token
	_ = CacheAccessToken(refreshResp.AccessToken, expiresAt)

	return refreshResp.AccessToken, nil
}

// GetUserInfo retrieves the current user's information
func GetUserInfo() (*UserInfo, error) {
	accessToken, err := GetAccessToken()
	if err != nil {
		return nil, err
	}

	cfg := GetConfig()
	client := &http.Client{Timeout: 30 * time.Second}

	userURL := fmt.Sprintf("%s/api/v1/users/me", cfg.StackAuthURL)
	req, err := http.NewRequest("GET", userURL, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("x-stack-project-id", cfg.ProjectID)
	req.Header.Set("x-stack-publishable-client-key", cfg.PublishableKey)
	req.Header.Set("x-stack-access-type", "client")
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to get user info: status %d", resp.StatusCode)
	}

	var userInfo UserInfo
	if err := json.NewDecoder(resp.Body).Decode(&userInfo); err != nil {
		return nil, err
	}

	return &userInfo, nil
}

// openBrowser opens the given URL in the default browser
func openBrowser(url string) error {
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

// Note: Morph API key is now managed server-side via Convex.
// The cmux CLI no longer needs to fetch or cache the API key locally.
// All Morph operations are proxied through Convex HTTP endpoints.

// UserProfile holds cached user profile information including team
type UserProfile struct {
	UserID          string `json:"userId"`
	Email           string `json:"email,omitempty"`
	Name            string `json:"name,omitempty"`
	TeamID          string `json:"teamId,omitempty"`
	TeamSlug        string `json:"teamSlug,omitempty"`
	TeamDisplayName string `json:"teamDisplayName,omitempty"`
	FetchedAt       int64  `json:"fetchedAt"`
}

// getUserProfileCachePath returns the path to the user profile cache file
func getUserProfileCachePath() (string, error) {
	configDir, err := getConfigDir()
	if err != nil {
		return "", err
	}

	cfg := GetConfig()
	filename := "user_profile_prod.json"
	if cfg.IsDev {
		filename = "user_profile_dev.json"
	}

	return filepath.Join(configDir, filename), nil
}

// GetCachedUserProfile returns the cached user profile if valid
func GetCachedUserProfile() (*UserProfile, error) {
	path, err := getUserProfileCachePath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("no cached user profile")
	}

	var profile UserProfile
	if err := json.Unmarshal(data, &profile); err != nil {
		return nil, fmt.Errorf("failed to parse cached profile: %w", err)
	}

	// Cache is valid for 24 hours
	if time.Now().Unix()-profile.FetchedAt > 24*60*60 {
		return nil, fmt.Errorf("cached profile expired")
	}

	return &profile, nil
}

// CacheUserProfile stores the user profile locally
func CacheUserProfile(profile *UserProfile) error {
	path, err := getUserProfileCachePath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}

	profile.FetchedAt = time.Now().Unix()

	data, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// ClearCachedUserProfile removes the cached user profile
func ClearCachedUserProfile() error {
	path, err := getUserProfileCachePath()
	if err != nil {
		return err
	}
	_ = os.Remove(path)
	return nil
}

// FetchUserProfile fetches the user profile from the server and caches it
func FetchUserProfile() (*UserProfile, error) {
	accessToken, err := GetAccessToken()
	if err != nil {
		return nil, fmt.Errorf("not logged in: %w", err)
	}

	cfg := GetConfig()
	client := &http.Client{Timeout: 30 * time.Second}

	profileURL := fmt.Sprintf("%s/api/v1/cmux/me", cfg.ConvexSiteURL)
	req, err := http.NewRequest("GET", profileURL, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch profile: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to fetch profile: status %d: %s", resp.StatusCode, string(body))
	}

	var profile UserProfile
	if err := json.NewDecoder(resp.Body).Decode(&profile); err != nil {
		return nil, fmt.Errorf("failed to decode profile: %w", err)
	}

	// Cache the profile
	if err := CacheUserProfile(&profile); err != nil {
		// Log but don't fail if caching fails
		fmt.Fprintf(os.Stderr, "Warning: failed to cache user profile: %v\n", err)
	}

	return &profile, nil
}

// GetUserProfile returns the user profile, using cache if available
func GetUserProfile() (*UserProfile, error) {
	// Try cache first
	if profile, err := GetCachedUserProfile(); err == nil {
		return profile, nil
	}

	// Fetch from server
	return FetchUserProfile()
}

// GetTeamSlug returns the user's team slug/ID, fetching if necessary
func GetTeamSlug() (string, error) {
	profile, err := GetUserProfile()
	if err != nil {
		return "", err
	}

	if profile.TeamSlug != "" {
		return profile.TeamSlug, nil
	}
	if profile.TeamID != "" {
		return profile.TeamID, nil
	}

	return "", fmt.Errorf("no team found for user. Please select a team at %s", GetConfig().CmuxURL)
}
