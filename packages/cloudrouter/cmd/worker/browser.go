package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/accessibility"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/dom"
	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
)

// browserManager manages a lazy connection to Chrome via CDP.
type browserManager struct {
	mu        sync.Mutex
	allocCtx  context.Context
	allocCanc context.CancelFunc
	ctx       context.Context
	ctxCanc   context.CancelFunc
}

var browser = &browserManager{}

// ensureConnected lazily connects (or reconnects) to Chrome CDP on port 9222.
func (bm *browserManager) ensureConnected() (context.Context, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	// If we already have a context, test it with a simple action.
	if bm.ctx != nil {
		err := chromedp.Run(bm.ctx)
		if err == nil {
			return bm.ctx, nil
		}
		log.Printf("[browser] existing connection stale: %v, reconnecting", err)
		bm.close()
	}

	// Get the browser WebSocket URL.
	wsURL, err := bm.getWSURL()
	if err != nil {
		return nil, fmt.Errorf("Chrome CDP not available: %w", err)
	}

	allocCtx, allocCanc := chromedp.NewRemoteAllocator(context.Background(), wsURL)
	bm.allocCtx = allocCtx
	bm.allocCanc = allocCanc

	// Find the first visible page target to attach to.
	targetID, err := bm.findPageTarget(allocCtx)
	if err != nil {
		allocCanc()
		return nil, fmt.Errorf("no page target found: %w", err)
	}

	ctx, cancel := chromedp.NewContext(allocCtx, chromedp.WithTargetID(targetID))
	bm.ctx = ctx
	bm.ctxCanc = cancel

	// Initialize the connection.
	if err := chromedp.Run(ctx); err != nil {
		bm.close()
		return nil, fmt.Errorf("failed to attach to page: %w", err)
	}

	log.Printf("[browser] connected to Chrome CDP, target=%s", targetID)
	return ctx, nil
}

func (bm *browserManager) getWSURL() (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://localhost:%d/json/version", cdpPort))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var data struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	if data.WebSocketDebuggerURL == "" {
		return "", fmt.Errorf("empty webSocketDebuggerUrl")
	}
	return data.WebSocketDebuggerURL, nil
}

func (bm *browserManager) findPageTarget(allocCtx context.Context) (target.ID, error) {
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	// Get list of targets.
	targets, err := chromedp.Targets(ctx)
	if err != nil {
		return "", err
	}

	// Prefer type "page".
	for _, t := range targets {
		if t.Type == "page" {
			return t.TargetID, nil
		}
	}
	// Fall back to any target.
	if len(targets) > 0 {
		return targets[0].TargetID, nil
	}
	return "", fmt.Errorf("no targets available")
}

func (bm *browserManager) close() {
	if bm.ctxCanc != nil {
		bm.ctxCanc()
		bm.ctxCanc = nil
	}
	if bm.allocCanc != nil {
		bm.allocCanc()
		bm.allocCanc = nil
	}
	bm.ctx = nil
	bm.allocCtx = nil
}

// Close is called on shutdown.
func (bm *browserManager) Close() {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	bm.close()
}

// Execute runs a browser command and returns the JSON-serializable result.
func (bm *browserManager) Execute(command string, body map[string]interface{}) (map[string]interface{}, error) {
	ctx, err := bm.ensureConnected()
	if err != nil {
		return nil, err
	}

	switch command {
	case "snapshot":
		return bm.cmdSnapshot(ctx)
	case "open":
		url, _ := body["url"].(string)
		if url == "" {
			return nil, fmt.Errorf("url required")
		}
		return bm.cmdOpen(ctx, url)
	case "click":
		selector, _ := body["selector"].(string)
		if selector == "" {
			return nil, fmt.Errorf("selector required")
		}
		return bm.cmdClick(ctx, selector)
	case "type":
		text, _ := body["text"].(string)
		if text == "" {
			return nil, fmt.Errorf("text required")
		}
		return bm.cmdType(ctx, text)
	case "fill":
		selector, _ := body["selector"].(string)
		value, hasValue := body["value"].(string)
		if selector == "" || !hasValue {
			return nil, fmt.Errorf("selector and value required")
		}
		return bm.cmdFill(ctx, selector, value)
	case "press":
		key, _ := body["key"].(string)
		if key == "" {
			return nil, fmt.Errorf("key required")
		}
		return bm.cmdPress(ctx, key)
	case "scroll":
		direction, _ := body["direction"].(string)
		if direction == "" {
			return nil, fmt.Errorf("direction required")
		}
		return bm.cmdScroll(ctx, direction)
	case "back":
		return bm.cmdBack(ctx)
	case "forward":
		return bm.cmdForward(ctx)
	case "reload":
		return bm.cmdReload(ctx)
	case "url":
		return bm.cmdURL(ctx)
	case "title":
		return bm.cmdTitle(ctx)
	case "wait":
		selector, _ := body["selector"].(string)
		if selector == "" {
			return nil, fmt.Errorf("selector required")
		}
		timeout := 30000
		if t, ok := body["timeout"].(float64); ok && t > 0 {
			timeout = int(t)
		}
		return bm.cmdWait(ctx, selector, timeout)
	case "hover":
		selector, _ := body["selector"].(string)
		if selector == "" {
			return nil, fmt.Errorf("selector required")
		}
		return bm.cmdHover(ctx, selector)
	default:
		return nil, fmt.Errorf("unknown command: %s", command)
	}
}

// Screenshot takes a PNG screenshot and returns the base64-encoded data.
func (bm *browserManager) Screenshot() (map[string]interface{}, error) {
	ctx, err := bm.ensureConnected()
	if err != nil {
		return nil, err
	}

	var buf []byte
	if err := chromedp.Run(ctx, chromedp.CaptureScreenshot(&buf)); err != nil {
		return nil, fmt.Errorf("screenshot failed: %w", err)
	}

	b64 := base64.StdEncoding.EncodeToString(buf)

	// Also save to /tmp/screenshot.png
	targetPath := "/tmp/screenshot.png"
	if writeErr := os.WriteFile(targetPath, buf, 0644); writeErr != nil {
		log.Printf("[browser] failed to save screenshot to %s: %v", targetPath, writeErr)
	}

	return map[string]interface{}{
		"success": true,
		"path":    targetPath,
		"base64":  b64,
		"data":    map[string]interface{}{"base64": b64},
	}, nil
}

// =============================================================================
// Individual command implementations
// =============================================================================

func (bm *browserManager) cmdSnapshot(ctx context.Context) (map[string]interface{}, error) {
	snapshot, err := bm.buildAccessibilitySnapshot(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"snapshot": snapshot},
	}, nil
}

func (bm *browserManager) cmdOpen(ctx context.Context, url string) (map[string]interface{}, error) {
	if err := chromedp.Run(ctx, chromedp.Navigate(url)); err != nil {
		return nil, fmt.Errorf("navigate failed: %w", err)
	}
	// Wait briefly for page to settle.
	chromedp.Run(ctx, chromedp.Sleep(500*time.Millisecond))
	return map[string]interface{}{
		"data": map[string]interface{}{"url": url},
	}, nil
}

func (bm *browserManager) cmdClick(ctx context.Context, selector string) (map[string]interface{}, error) {
	if strings.HasPrefix(selector, "@e") {
		objID, err := bm.resolveElementRef(ctx, selector)
		if err != nil {
			return nil, err
		}
		_, _, err = runtime.CallFunctionOn(`function() { this.click(); }`).
			WithObjectID(objID).Do(ctx)
		if err != nil {
			return nil, fmt.Errorf("click failed: %w", err)
		}
	} else {
		if err := chromedp.Run(ctx, chromedp.Click(selector, chromedp.ByQuery)); err != nil {
			return nil, fmt.Errorf("click failed: %w", err)
		}
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"clicked": selector},
	}, nil
}

func (bm *browserManager) cmdType(ctx context.Context, text string) (map[string]interface{}, error) {
	if err := chromedp.Run(ctx, chromedp.KeyEvent(text)); err != nil {
		return nil, fmt.Errorf("type failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"typed": text},
	}, nil
}

func (bm *browserManager) cmdFill(ctx context.Context, selector, value string) (map[string]interface{}, error) {
	if strings.HasPrefix(selector, "@e") {
		objID, err := bm.resolveElementRef(ctx, selector)
		if err != nil {
			return nil, err
		}
		// Focus, clear, set value, dispatch input event
		js := fmt.Sprintf(`function() {
			this.focus();
			this.value = '';
			this.value = %s;
			this.dispatchEvent(new Event('input', {bubbles: true}));
			this.dispatchEvent(new Event('change', {bubbles: true}));
		}`, strconv.Quote(value))
		_, _, err = runtime.CallFunctionOn(js).
			WithObjectID(objID).Do(ctx)
		if err != nil {
			return nil, fmt.Errorf("fill failed: %w", err)
		}
	} else {
		// CSS selector: click to focus, triple-click to select all, then type value
		if err := chromedp.Run(ctx,
			chromedp.Click(selector, chromedp.ByQuery),
			chromedp.Evaluate(fmt.Sprintf(
				`document.querySelector(%s).value = ''; document.querySelector(%s).focus();`,
				strconv.Quote(selector), strconv.Quote(selector)), nil),
			chromedp.SendKeys(selector, value, chromedp.ByQuery),
		); err != nil {
			return nil, fmt.Errorf("fill failed: %w", err)
		}
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"filled": selector, "value": value},
	}, nil
}

func (bm *browserManager) cmdPress(ctx context.Context, key string) (map[string]interface{}, error) {
	// Map common key names to chromedp key codes
	k := mapKeyName(key)
	if err := chromedp.Run(ctx, chromedp.KeyEvent(k)); err != nil {
		return nil, fmt.Errorf("press failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"pressed": key},
	}, nil
}

func (bm *browserManager) cmdScroll(ctx context.Context, direction string) (map[string]interface{}, error) {
	delta := 500
	if strings.EqualFold(direction, "up") {
		delta = -500
	}
	js := fmt.Sprintf("window.scrollBy(0, %d)", delta)
	if err := chromedp.Run(ctx, chromedp.Evaluate(js, nil)); err != nil {
		return nil, fmt.Errorf("scroll failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"scrolled": strings.ToLower(direction)},
	}, nil
}

func (bm *browserManager) cmdBack(ctx context.Context) (map[string]interface{}, error) {
	if err := chromedp.Run(ctx, chromedp.NavigateBack()); err != nil {
		return nil, fmt.Errorf("back failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"navigated": "back"},
	}, nil
}

func (bm *browserManager) cmdForward(ctx context.Context) (map[string]interface{}, error) {
	if err := chromedp.Run(ctx, chromedp.NavigateForward()); err != nil {
		return nil, fmt.Errorf("forward failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"navigated": "forward"},
	}, nil
}

func (bm *browserManager) cmdReload(ctx context.Context) (map[string]interface{}, error) {
	if err := chromedp.Run(ctx, chromedp.Reload()); err != nil {
		return nil, fmt.Errorf("reload failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"reloaded": true},
	}, nil
}

func (bm *browserManager) cmdURL(ctx context.Context) (map[string]interface{}, error) {
	var url string
	if err := chromedp.Run(ctx, chromedp.Location(&url)); err != nil {
		return nil, fmt.Errorf("url failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"url": url},
	}, nil
}

func (bm *browserManager) cmdTitle(ctx context.Context) (map[string]interface{}, error) {
	var title string
	if err := chromedp.Run(ctx, chromedp.Title(&title)); err != nil {
		return nil, fmt.Errorf("title failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"title": title},
	}, nil
}

func (bm *browserManager) cmdWait(ctx context.Context, selector string, timeoutMs int) (map[string]interface{}, error) {
	tctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	if strings.HasPrefix(selector, "@e") {
		// Poll the accessibility tree until the element ref exists
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-tctx.Done():
				return nil, fmt.Errorf("timeout waiting for %s", selector)
			case <-ticker.C:
				_, err := bm.resolveElementRef(tctx, selector)
				if err == nil {
					return map[string]interface{}{
						"data": map[string]interface{}{"found": selector},
					}, nil
				}
			}
		}
	}

	// CSS selector
	if err := chromedp.Run(tctx, chromedp.WaitVisible(selector, chromedp.ByQuery)); err != nil {
		return nil, fmt.Errorf("wait failed: %w", err)
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"found": selector},
	}, nil
}

func (bm *browserManager) cmdHover(ctx context.Context, selector string) (map[string]interface{}, error) {
	if strings.HasPrefix(selector, "@e") {
		objID, err := bm.resolveElementRef(ctx, selector)
		if err != nil {
			return nil, err
		}
		// Get the element's bounding box via JS, then dispatch mouseMoved
		res, _, err := runtime.CallFunctionOn(`function() {
			var rect = this.getBoundingClientRect();
			return JSON.stringify({x: rect.x + rect.width/2, y: rect.y + rect.height/2});
		}`).WithObjectID(objID).WithReturnByValue(true).Do(ctx)
		if err != nil {
			return nil, fmt.Errorf("hover failed to get position: %w", err)
		}
		// res.Value is jsontext.Value ([]byte) containing a JSON string like "\"...\""
		// First unquote the JSON string, then parse the inner JSON object.
		var posJSON string
		if err := json.Unmarshal([]byte(res.Value), &posJSON); err != nil {
			return nil, fmt.Errorf("hover failed to parse position string: %w", err)
		}
		var pos struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
		}
		if err := json.Unmarshal([]byte(posJSON), &pos); err != nil {
			return nil, fmt.Errorf("hover failed to parse coords: %w", err)
		}
		if err := input.DispatchMouseEvent(input.MouseMoved, pos.X, pos.Y).Do(ctx); err != nil {
			return nil, fmt.Errorf("hover failed: %w", err)
		}
	} else {
		if err := chromedp.Run(ctx, chromedp.MouseClickXY(0, 0, chromedp.ButtonNone)); err != nil {
			// Fallback: use JS to dispatch mouseover
			js := fmt.Sprintf(`document.querySelector(%s)?.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}))`, strconv.Quote(selector))
			if err2 := chromedp.Run(ctx, chromedp.Evaluate(js, nil)); err2 != nil {
				return nil, fmt.Errorf("hover failed: %w", err2)
			}
		}
	}
	return map[string]interface{}{
		"data": map[string]interface{}{"hovered": selector},
	}, nil
}

// RunBrowserAgent shells out to the browser-agent-runner.js script.
func (bm *browserManager) RunBrowserAgent(body map[string]interface{}) (map[string]interface{}, error) {
	prompt, _ := body["prompt"].(string)
	if prompt == "" {
		return nil, fmt.Errorf("prompt required")
	}

	timeout := 120 * time.Second
	if t, ok := body["timeout"].(float64); ok && t > 0 {
		timeout = time.Duration(t) * time.Millisecond
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", "/usr/local/bin/browser-agent-runner.js")
	cmd.Dir = workspaceDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("CDP_ENDPOINT=http://localhost:%d", cdpPort),
		"BROWSER_AGENT_PROMPT="+prompt,
	)
	if sp, ok := body["screenshotPath"].(string); ok && sp != "" {
		cmd.Env = append(cmd.Env, "BROWSER_AGENT_SCREENSHOT_PATH="+sp)
	}

	stdout, err := cmd.Output()
	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	var stderr string
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = string(ee.Stderr)
		}
	}

	return map[string]interface{}{
		"stdout":    strings.TrimSpace(string(stdout)),
		"stderr":    strings.TrimSpace(stderr),
		"exit_code": exitCode,
	}, nil
}

// =============================================================================
// Accessibility tree helpers
// =============================================================================

// axNode is a simplified accessibility node for tree building.
type axNode struct {
	NodeID    accessibility.NodeID
	ParentID  accessibility.NodeID
	Role      string
	Name      string
	Value     string
	Focused   bool
	Ignored   bool
	BackendID cdp.BackendNodeID
	Children  []*axNode
}

func (bm *browserManager) buildAccessibilitySnapshot(ctx context.Context) (string, error) {
	// Get the full accessibility tree via CDP.
	nodes, err := accessibility.GetFullAXTree().Do(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get accessibility tree: %w", err)
	}

	if len(nodes) == 0 {
		return "No accessibility tree available", nil
	}

	// Build a map of nodeID → axNode.
	nodeMap := make(map[accessibility.NodeID]*axNode, len(nodes))
	var roots []*axNode

	for _, n := range nodes {
		an := &axNode{
			NodeID: n.NodeID,
			Ignored: n.Ignored,
		}
		if n.ParentID != "" {
			an.ParentID = n.ParentID
		}
		if n.Role != nil {
			an.Role = unquoteJSON(string(n.Role.Value))
		}
		if n.Name != nil {
			an.Name = unquoteJSON(string(n.Name.Value))
		}
		// Check properties for value and focused.
		for _, p := range n.Properties {
			switch p.Name.String() {
			case "focused":
				an.Focused = strings.TrimSpace(string(p.Value.Value)) == "true"
			case "value":
				an.Value = unquoteJSON(string(p.Value.Value))
			}
		}
		if n.BackendDOMNodeID != 0 {
			an.BackendID = n.BackendDOMNodeID
		}
		nodeMap[n.NodeID] = an
	}

	// Link children to parents.
	for _, an := range nodeMap {
		if an.ParentID != "" {
			if parent, ok := nodeMap[an.ParentID]; ok {
				parent.Children = append(parent.Children, an)
			} else {
				roots = append(roots, an)
			}
		} else {
			roots = append(roots, an)
		}
	}

	// Sort children by original order (by NodeID for stability).
	var sortChildren func(nodes []*axNode)
	sortChildren = func(nodes []*axNode) {
		sort.Slice(nodes, func(i, j int) bool {
			return nodes[i].NodeID < nodes[j].NodeID
		})
		for _, n := range nodes {
			if len(n.Children) > 0 {
				sortChildren(n.Children)
			}
		}
	}
	sortChildren(roots)

	// Traverse and format, skipping ignored nodes and InlineTextBox role.
	var lines []string
	refCounter := 0
	var traverse func(node *axNode, indent int)
	traverse = func(node *axNode, indent int) {
		if node.Ignored || node.Role == "InlineTextBox" {
			// Still recurse into children of ignored nodes.
			for _, child := range node.Children {
				traverse(child, indent)
			}
			return
		}

		refCounter++
		prefix := strings.Repeat("  ", indent)
		ref := fmt.Sprintf("@e%d", refCounter)
		line := fmt.Sprintf("%s%s [%s]", prefix, ref, node.Role)
		if node.Name != "" {
			line += fmt.Sprintf(" %q", node.Name)
		}
		if node.Value != "" {
			line += fmt.Sprintf(" value=%q", node.Value)
		}
		if node.Focused {
			line += " (focused)"
		}
		lines = append(lines, line)

		for _, child := range node.Children {
			traverse(child, indent+1)
		}
	}

	for _, root := range roots {
		traverse(root, 0)
	}

	if len(lines) == 0 {
		return "No accessibility tree available", nil
	}

	return strings.Join(lines, "\n"), nil
}

// resolveElementRef resolves an @eN reference to a runtime.RemoteObjectID.
func (bm *browserManager) resolveElementRef(ctx context.Context, ref string) (runtime.RemoteObjectID, error) {
	refNum, err := strconv.Atoi(ref[2:])
	if err != nil || refNum < 1 {
		return "", fmt.Errorf("invalid element ref: %s", ref)
	}

	nodes, err := accessibility.GetFullAXTree().Do(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get accessibility tree: %w", err)
	}

	// Count non-ignored, non-InlineTextBox nodes in pre-order.
	// Build parent map first.
	type nodeInfo struct {
		node     *accessibility.Node
		children []*accessibility.Node
	}
	nodeMap := make(map[accessibility.NodeID]*nodeInfo, len(nodes))
	var roots []*accessibility.Node

	for i := range nodes {
		n := nodes[i]
		nodeMap[n.NodeID] = &nodeInfo{node: n}
	}
	for i := range nodes {
		n := nodes[i]
		if n.ParentID != "" {
			if parent, ok := nodeMap[n.ParentID]; ok {
				parent.children = append(parent.children, n)
			} else {
				roots = append(roots, n)
			}
		} else {
			roots = append(roots, n)
		}
	}

	// Sort children for deterministic order.
	for _, ni := range nodeMap {
		sort.Slice(ni.children, func(i, j int) bool {
			return ni.children[i].NodeID < ni.children[j].NodeID
		})
	}
	sort.Slice(roots, func(i, j int) bool {
		return roots[i].NodeID < roots[j].NodeID
	})

	// Pre-order traversal counting non-ignored nodes.
	counter := 0
	var target *accessibility.Node
	var walk func(n *accessibility.Node) bool
	walk = func(n *accessibility.Node) bool {
		role := ""
		if n.Role != nil {
			role = unquoteJSON(string(n.Role.Value))
		}
		ignored := n.Ignored || role == "InlineTextBox"
		if !ignored {
			counter++
			if counter == refNum {
				target = n
				return true
			}
		}
		if ni, ok := nodeMap[n.NodeID]; ok {
			for _, child := range ni.children {
				if walk(child) {
					return true
				}
			}
		}
		return false
	}

	for _, root := range roots {
		if walk(root) {
			break
		}
	}

	if target == nil {
		return "", fmt.Errorf("element %s not found", ref)
	}

	if target.BackendDOMNodeID == 0 {
		return "", fmt.Errorf("element %s has no DOM node", ref)
	}

	// Resolve backend node to remote object.
	obj, err := dom.ResolveNode().WithBackendNodeID(target.BackendDOMNodeID).Do(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to resolve DOM node for %s: %w", ref, err)
	}

	return obj.ObjectID, nil
}

// unquoteJSON strips JSON string quotes from a raw JSON value.
// e.g., `"hello"` → `hello`, `true` → `true`, `123` → `123`
func unquoteJSON(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		var s string
		if err := json.Unmarshal([]byte(raw), &s); err == nil {
			return s
		}
	}
	return raw
}

// mapKeyName maps human-friendly key names to the strings chromedp expects.
func mapKeyName(key string) string {
	keyMap := map[string]string{
		"Enter":      "\r",
		"Tab":        "\t",
		"Backspace":  "\b",
		"Escape":     "\x1b",
		"ArrowUp":    "\ue013",
		"ArrowDown":  "\ue015",
		"ArrowLeft":  "\ue012",
		"ArrowRight": "\ue014",
		"Delete":     "\ue017",
		"Home":       "\ue011",
		"End":        "\ue010",
		"PageUp":     "\ue00e",
		"PageDown":   "\ue00f",
		"Space":      " ",
	}
	if v, ok := keyMap[key]; ok {
		return v
	}
	return key
}
