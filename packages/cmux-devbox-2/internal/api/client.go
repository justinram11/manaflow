// Package api provides the E2B API client
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/cmux-cli/cmux-devbox-2/internal/auth"
)

type Client struct {
	baseURL    string
	httpClient *http.Client
}

func NewClient() *Client {
	cfg := auth.GetConfig()
	return &Client{
		baseURL:    cfg.ConvexSiteURL,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) doRequest(method, path string, body interface{}) ([]byte, error) {
	token, err := auth.GetAccessToken()
	if err != nil {
		return nil, err
	}

	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

// Instance represents an E2B sandbox instance
type Instance struct {
	ID        string `json:"id"`
	DevboxID  string `json:"devboxId"`
	Name      string `json:"name,omitempty"`
	Status    string `json:"status"`
	Template  string `json:"templateId,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
	VSCodeURL string `json:"vscodeUrl,omitempty"`
	VNCURL    string `json:"vncUrl,omitempty"`
	WorkerURL string `json:"workerUrl,omitempty"`
}

type CreateInstanceRequest struct {
	TeamSlugOrID string `json:"teamSlugOrId"`
	TemplateID   string `json:"templateId,omitempty"`
	Name         string `json:"name,omitempty"`
}

// CreateInstanceID handles the nested id object from Convex
type CreateInstanceID struct {
	ID         string `json:"id"`
	IsExisting bool   `json:"isExisting"`
}

type createInstanceRawResponse struct {
	ID            CreateInstanceID `json:"id"`
	E2BInstanceID string           `json:"e2bInstanceId"`
	Status        string           `json:"status"`
	VSCodeURL     string           `json:"vscodeUrl,omitempty"`
	WorkerURL     string           `json:"workerUrl,omitempty"`
	VNCURL        string           `json:"vncUrl,omitempty"`
}

type CreateInstanceResponse struct {
	DevboxID      string `json:"devboxId"`
	E2BInstanceID string `json:"e2bInstanceId"`
	Status        string `json:"status"`
	VSCodeURL     string `json:"vscodeUrl,omitempty"`
	WorkerURL     string `json:"workerUrl,omitempty"`
	VNCURL        string `json:"vncUrl,omitempty"`
}

func (c *Client) CreateInstance(teamSlug, templateID, name string) (*CreateInstanceResponse, error) {
	body := CreateInstanceRequest{
		TeamSlugOrID: teamSlug,
		TemplateID:   templateID,
		Name:         name,
	}

	respBody, err := c.doRequest("POST", "/api/v2/cmux/instances", body)
	if err != nil {
		return nil, err
	}

	var raw createInstanceRawResponse
	if err := json.Unmarshal(respBody, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w (body: %s)", err, string(respBody))
	}

	return &CreateInstanceResponse{
		DevboxID:      raw.ID.ID,
		E2BInstanceID: raw.E2BInstanceID,
		Status:        raw.Status,
		VSCodeURL:     raw.VSCodeURL,
		WorkerURL:     raw.WorkerURL,
		VNCURL:        raw.VNCURL,
	}, nil
}

type ListInstancesResponse struct {
	Instances []Instance `json:"instances"`
}

func (c *Client) ListInstances(teamSlug string) ([]Instance, error) {
	path := fmt.Sprintf("/api/v2/cmux/instances?teamSlugOrId=%s", teamSlug)
	respBody, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}

	var resp ListInstancesResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, err
	}
	return resp.Instances, nil
}

func (c *Client) GetInstance(teamSlug, id string) (*Instance, error) {
	path := fmt.Sprintf("/api/v2/cmux/instances/%s?teamSlugOrId=%s", id, teamSlug)
	respBody, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}

	var inst Instance
	if err := json.Unmarshal(respBody, &inst); err != nil {
		return nil, err
	}
	return &inst, nil
}

func (c *Client) StopInstance(teamSlug, id string) error {
	path := fmt.Sprintf("/api/v2/cmux/instances/%s/stop", id)
	_, err := c.doRequest("POST", path, map[string]string{"teamSlugOrId": teamSlug})
	return err
}

// ExtendTimeout extends the sandbox timeout (E2B doesn't have pause/resume)
func (c *Client) ExtendTimeout(teamSlug, id string, timeoutMs int) error {
	path := fmt.Sprintf("/api/v2/cmux/instances/%s/extend", id)
	body := map[string]interface{}{
		"teamSlugOrId": teamSlug,
		"timeoutMs":    timeoutMs,
	}
	_, err := c.doRequest("POST", path, body)
	return err
}

type ExecRequest struct {
	TeamSlugOrID string `json:"teamSlugOrId"`
	Command      string `json:"command"`
	Timeout      int    `json:"timeout,omitempty"`
}

type ExecResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

func (c *Client) Exec(teamSlug, id, command string, timeout int) (*ExecResponse, error) {
	path := fmt.Sprintf("/api/v2/cmux/instances/%s/exec", id)
	body := ExecRequest{
		TeamSlugOrID: teamSlug,
		Command:      command,
		Timeout:      timeout,
	}

	respBody, err := c.doRequest("POST", path, body)
	if err != nil {
		return nil, err
	}

	var resp ExecResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

type Template struct {
	ID             string `json:"templateId"`
	PresetID       string `json:"presetId"`
	Name           string `json:"name"`
	Description    string `json:"description,omitempty"`
	SupportsDocker bool   `json:"supportsDocker,omitempty"`
}

type ListTemplatesResponse struct {
	Templates []Template `json:"templates"`
}

func (c *Client) ListTemplates(teamSlug string) ([]Template, error) {
	path := fmt.Sprintf("/api/v2/cmux/templates?teamSlugOrId=%s", teamSlug)
	respBody, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}

	var resp ListTemplatesResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, err
	}
	return resp.Templates, nil
}

type AuthTokenResponse struct {
	Token string `json:"token"`
}

// GetAuthToken fetches the auth token from the sandbox
func (c *Client) GetAuthToken(teamSlug, id string) (string, error) {
	path := fmt.Sprintf("/api/v2/cmux/instances/%s/token", id)
	body := map[string]string{"teamSlugOrId": teamSlug}

	respBody, err := c.doRequest("POST", path, body)
	if err != nil {
		return "", err
	}

	var resp AuthTokenResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", err
	}
	return resp.Token, nil
}

// DoWorkerRequest makes a direct request to the worker daemon
func DoWorkerRequest(workerURL, path, token string, body []byte) ([]byte, error) {
	return DoWorkerRequestWithTimeout(workerURL, path, token, body, 60)
}

// DoWorkerRequestWithTimeout makes a direct request to the worker daemon with custom timeout
func DoWorkerRequestWithTimeout(workerURL, path, token string, body []byte, timeoutSecs int) ([]byte, error) {
	client := &http.Client{Timeout: time.Duration(timeoutSecs) * time.Second}

	req, err := http.NewRequest("POST", workerURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("worker error (%d): %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}
