#!/usr/bin/env node
/**
 * DBA Worker Daemon
 *
 * HTTP server that wraps agent-browser commands.
 * Runs on port 39377 (exposed via Morph's worker URL).
 *
 * Authentication:
 * - Requires DBA_WORKER_TOKEN environment variable to be set
 * - All requests must include Authorization: Bearer <token> header
 * - Token is generated at VM creation and stored securely
 */

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 39377;
const TOKEN_FILE = '/var/run/dba/worker-token';

// Get or generate auth token
let AUTH_TOKEN = process.env.DBA_WORKER_TOKEN;
if (!AUTH_TOKEN) {
  // Try to read from file
  try {
    AUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    // Generate new token and save it
    AUTH_TOKEN = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 });
      console.log(`Generated new auth token, saved to ${TOKEN_FILE}`);
    } catch (writeErr) {
      console.error('Warning: Could not save token file:', writeErr.message);
    }
  }
}

/**
 * Verify authentication token
 */
function verifyAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return false;
  }
  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) {
    return false;
  }
  // Constant-time comparison to prevent timing attacks
  if (token.length !== AUTH_TOKEN.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
}

/**
 * Run an agent-browser command and return the result
 * Uses CDP to connect to the existing Chrome on port 9222
 */
async function runAgentBrowser(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('agent-browser', [...args, '--cdp', '9222', '--json'], {
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Exit code ${code}`));
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ success: true, data: stdout });
        }
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Parse JSON body from request
 */
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Handle requests
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const reqPath = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check doesn't require auth
  if (reqPath === '/health') {
    sendJson(res, { status: 'ok' });
    return;
  }

  // All other endpoints require authentication
  if (!verifyAuth(req)) {
    sendJson(res, { error: 'Unauthorized', message: 'Valid Bearer token required' }, 401);
    return;
  }

  try {
    let result;
    let body = {};

    if (req.method === 'POST') {
      body = await parseBody(req);
    }

    switch (reqPath) {

      case '/snapshot':
        const snapshotArgs = ['snapshot'];
        if (body.interactive) snapshotArgs.push('-i');
        if (body.compact) snapshotArgs.push('-c');
        result = await runAgentBrowser(snapshotArgs);
        break;

      case '/open':
        if (!body.url) {
          sendJson(res, { error: 'url required' }, 400);
          return;
        }
        result = await runAgentBrowser(['open', body.url]);
        break;

      case '/click':
        if (!body.selector) {
          sendJson(res, { error: 'selector required' }, 400);
          return;
        }
        result = await runAgentBrowser(['click', body.selector]);
        break;

      case '/dblclick':
        if (!body.selector) {
          sendJson(res, { error: 'selector required' }, 400);
          return;
        }
        result = await runAgentBrowser(['dblclick', body.selector]);
        break;

      case '/type':
        if (!body.text) {
          sendJson(res, { error: 'text required' }, 400);
          return;
        }
        result = await runAgentBrowser(['type', body.selector || '', body.text]);
        break;

      case '/fill':
        if (!body.selector || body.value === undefined) {
          sendJson(res, { error: 'selector and value required' }, 400);
          return;
        }
        result = await runAgentBrowser(['fill', body.selector, body.value]);
        break;

      case '/press':
        if (!body.key) {
          sendJson(res, { error: 'key required' }, 400);
          return;
        }
        result = await runAgentBrowser(['press', body.key]);
        break;

      case '/hover':
        if (!body.selector) {
          sendJson(res, { error: 'selector required' }, 400);
          return;
        }
        result = await runAgentBrowser(['hover', body.selector]);
        break;

      case '/scroll':
        const dir = body.direction || 'down';
        const amount = body.amount ? String(body.amount) : undefined;
        const scrollArgs = ['scroll', dir];
        if (amount) scrollArgs.push(amount);
        result = await runAgentBrowser(scrollArgs);
        break;

      case '/screenshot':
        // Take screenshot and return base64
        const ssResult = await runAgentBrowser(['screenshot']);
        if (ssResult.success && ssResult.data && ssResult.data.path) {
          const imgData = fs.readFileSync(ssResult.data.path);
          const base64 = imgData.toString('base64');
          result = { success: true, data: { base64 } };
          // Clean up temp file
          try { fs.unlinkSync(ssResult.data.path); } catch (e) {}
        } else {
          result = ssResult;
        }
        break;

      case '/back':
        result = await runAgentBrowser(['back']);
        break;

      case '/forward':
        result = await runAgentBrowser(['forward']);
        break;

      case '/reload':
        result = await runAgentBrowser(['reload']);
        break;

      case '/url':
        result = await runAgentBrowser(['get', 'url']);
        break;

      case '/title':
        result = await runAgentBrowser(['get', 'title']);
        break;

      case '/wait':
        if (!body.selector) {
          sendJson(res, { error: 'selector required' }, 400);
          return;
        }
        result = await runAgentBrowser(['wait', body.selector]);
        break;

      case '/eval':
        if (!body.script) {
          sendJson(res, { error: 'script required' }, 400);
          return;
        }
        result = await runAgentBrowser(['eval', body.script]);
        break;

      default:
        sendJson(res, { error: 'Not found' }, 404);
        return;
    }

    sendJson(res, result);
  } catch (err) {
    console.error('Error:', err.message);
    sendJson(res, { success: false, error: err.message }, 500);
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DBA Worker daemon listening on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
