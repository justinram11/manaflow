#!/usr/bin/env bun
/**
 * Test script for the video recording and cursor overlay pipeline.
 *
 * This script:
 * 1. Serves a fake HTML page that cycles through colors
 * 2. Generates fake trajectory/events.log with simulated click events
 * 3. Records the screen with ffmpeg
 * 4. Runs the cursor overlay post-processing
 * 5. Validates the output video
 *
 * Usage:
 *   cd packages/host-screenshot-collector
 *   bun run src/test-video-pipeline.ts [outputDir]
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import * as http from "node:http";

const execAsync = promisify(exec);

// Configuration
const DEFAULT_OUTPUT_DIR = "/tmp/test-video-pipeline";
const DISPLAY = process.env.DISPLAY || ":1";
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const FRAMERATE = 24;
const HTTP_PORT = 19999;

// Color cycle for the fake page
const COLORS = [
  { bg: "#FF6B6B", name: "Red" },
  { bg: "#4ECDC4", name: "Teal" },
  { bg: "#45B7D1", name: "Blue" },
  { bg: "#96CEB4", name: "Green" },
  { bg: "#FFEAA7", name: "Yellow" },
  { bg: "#DDA0DD", name: "Plum" },
  { bg: "#FF9F43", name: "Orange" },
  { bg: "#54A0FF", name: "Sky Blue" },
];

// Fake click positions (simulating button clicks at different screen locations)
const FAKE_CLICKS = [
  { x: 200, y: 150, width: 100, height: 40, delayMs: 500 },   // Top-left button
  { x: 960, y: 540, width: 150, height: 50, delayMs: 800 },   // Center button
  { x: 1700, y: 200, width: 120, height: 40, delayMs: 600 },  // Top-right button
  { x: 400, y: 800, width: 200, height: 60, delayMs: 700 },   // Bottom-left button
  { x: 1400, y: 700, width: 180, height: 45, delayMs: 500 },  // Bottom-right button
];

/**
 * Generate HTML for the fake color-cycling page
 */
function generateColorCycleHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Color Cycle Test Page</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
      transition: background-color 0.5s ease;
    }
    h1 {
      font-size: 4rem;
      color: white;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
      margin-bottom: 2rem;
    }
    .color-name {
      font-size: 2rem;
      color: rgba(255,255,255,0.8);
      margin-bottom: 3rem;
    }
    .button-container {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2rem;
      padding: 2rem;
    }
    .btn {
      padding: 1rem 2rem;
      font-size: 1.2rem;
      border: none;
      border-radius: 8px;
      background: rgba(255,255,255,0.9);
      color: #333;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .btn:active {
      transform: scale(0.95);
    }
    .counter {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      font-size: 1.5rem;
      color: white;
      background: rgba(0,0,0,0.3);
      padding: 0.5rem 1rem;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <h1>Video Pipeline Test</h1>
  <div class="color-name" id="colorName">Loading...</div>
  <div class="button-container">
    <button class="btn" onclick="handleClick(this)">Button 1</button>
    <button class="btn" onclick="handleClick(this)">Button 2</button>
    <button class="btn" onclick="handleClick(this)">Button 3</button>
    <button class="btn" onclick="handleClick(this)">Button 4</button>
    <button class="btn" onclick="handleClick(this)">Button 5</button>
    <button class="btn" onclick="handleClick(this)">Button 6</button>
  </div>
  <div class="counter" id="counter">Cycle: 0</div>

  <script>
    const colors = ${JSON.stringify(COLORS)};
    let currentIndex = 0;
    let cycleCount = 0;

    function updateColor() {
      const color = colors[currentIndex];
      document.body.style.backgroundColor = color.bg;
      document.getElementById('colorName').textContent = color.name;
      currentIndex = (currentIndex + 1) % colors.length;
      if (currentIndex === 0) {
        cycleCount++;
        document.getElementById('counter').textContent = 'Cycle: ' + cycleCount;
      }
    }

    function handleClick(btn) {
      btn.style.background = '#4CAF50';
      btn.textContent = 'Clicked!';
      setTimeout(() => {
        btn.style.background = 'rgba(255,255,255,0.9)';
        btn.textContent = btn.textContent.replace('Clicked!', 'Button ' + (Array.from(document.querySelectorAll('.btn')).indexOf(btn) + 1));
      }, 300);
    }

    // Start color cycling
    updateColor();
    setInterval(updateColor, 800);
  </script>
</body>
</html>`;
}

/**
 * Start a simple HTTP server serving the color cycle page
 */
async function startHTTPServer(): Promise<http.Server> {
  const html = generateColorCycleHTML();

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });

    server.listen(HTTP_PORT, () => {
      console.log(`[HTTP] Server started on http://localhost:${HTTP_PORT}`);
      resolve(server);
    });
  });
}

/**
 * Generate fake events.log with bounding_rect and pretool events
 */
async function generateFakeEventsLog(outputDir: string, recordingStartTime: number): Promise<void> {
  const eventsLogPath = path.join(outputDir, "events.log");
  const events: string[] = [];

  // Recording start event
  events.push(JSON.stringify({
    timestamp: recordingStartTime,
    event: "recording_start",
  }));

  // Generate click events with bounding_rect before each
  let currentTime = recordingStartTime + 500; // Start clicks 500ms after recording

  for (let i = 0; i < FAKE_CLICKS.length; i++) {
    const click = FAKE_CLICKS[i]!;
    const uid = `1_${1000 + i}`; // Fake CDP uid format: contextId_backendNodeId

    // Bounding rect event (logged by pretool hook when it calls CDP)
    events.push(JSON.stringify({
      timestamp: currentTime,
      event: "bounding_rect",
      x: click.x,
      y: click.y,
      width: click.width,
      height: click.height,
      uid,
    }));

    // Pretool click event (logged right after bounding rect)
    events.push(JSON.stringify({
      timestamp: currentTime + 10, // 10ms after bounding rect
      event: "pretool",
      tool: "mcp__chrome__click",
      uid,
    }));

    currentTime += click.delayMs;
  }

  await fs.writeFile(eventsLogPath, events.join("\n") + "\n");
  console.log(`[EVENTS] Generated ${events.length} events in ${eventsLogPath}`);
}

/**
 * Generate fake trajectory.jsonl with simulated Claude messages
 */
async function generateFakeTrajectory(outputDir: string, recordingStartTime: number): Promise<void> {
  const trajectoryPath = path.join(outputDir, "trajectory.jsonl");
  const entries: string[] = [];

  // Initial system message
  entries.push(JSON.stringify({
    timestamp: recordingStartTime - 1000,
    message: {
      type: "system",
      subtype: "init",
      cwd: "/root/workspace",
      session_id: "test-session-" + Date.now(),
      tools: ["Task", "Bash", "Read", "Edit", "Write"],
    },
  }));

  // Assistant message with tool_use for clicks
  let currentTime = recordingStartTime + 500;

  for (let i = 0; i < FAKE_CLICKS.length; i++) {
    const uid = `1_${1000 + i}`;

    entries.push(JSON.stringify({
      timestamp: currentTime,
      message: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: `toolu_${i}`,
              name: "mcp__chrome__click",
              input: { uid },
            },
          ],
        },
      },
    }));

    // Tool result
    entries.push(JSON.stringify({
      timestamp: currentTime + 100,
      message: {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `toolu_${i}`,
              content: "Click successful",
            },
          ],
        },
      },
    }));

    currentTime += FAKE_CLICKS[i]!.delayMs;
  }

  // Final result
  entries.push(JSON.stringify({
    timestamp: currentTime + 500,
    message: {
      type: "result",
      result: "Video recording test completed successfully. hasUiChanges=true",
      duration_ms: currentTime - recordingStartTime,
      duration_api_ms: currentTime - recordingStartTime - 200,
      num_turns: FAKE_CLICKS.length + 1,
      usage: {
        input_tokens: 5000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2000,
      },
      cost_usd: 0.05,
    },
  }));

  await fs.writeFile(trajectoryPath, entries.join("\n") + "\n");
  console.log(`[TRAJECTORY] Generated ${entries.length} entries in ${trajectoryPath}`);
}

/**
 * Start ffmpeg recording
 */
function startFFmpegRecording(outputDir: string): Promise<{ process: ReturnType<typeof spawn>; pid: number }> {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(outputDir, "raw.mp4");

    const ffmpegArgs = [
      "-y",
      "-f", "x11grab",
      "-draw_mouse", "0",
      "-framerate", String(FRAMERATE),
      "-video_size", `${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,
      "-i", `${DISPLAY}+0,0`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "26",
      "-pix_fmt", "yuv420p",
      outputPath,
    ];

    console.log(`[FFMPEG] Starting recording: ffmpeg ${ffmpegArgs.join(" ")}`);

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      env: { ...process.env, DISPLAY },
      stdio: ["pipe", "pipe", "pipe"],
    });

    ffmpegProcess.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("frame=") || msg.includes("time=")) {
        // Progress updates - only log occasionally
        if (Math.random() < 0.1) {
          process.stdout.write(".");
        }
      }
    });

    // Give ffmpeg time to start
    setTimeout(() => {
      if (ffmpegProcess.pid) {
        console.log(`\n[FFMPEG] Recording started with PID ${ffmpegProcess.pid}`);
        resolve({ process: ffmpegProcess, pid: ffmpegProcess.pid });
      } else {
        reject(new Error("FFmpeg failed to start"));
      }
    }, 500);

    ffmpegProcess.on("error", (err) => {
      console.error(`[FFMPEG] Error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Stop ffmpeg recording gracefully
 */
async function stopFFmpegRecording(ffmpegProcess: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    console.log("[FFMPEG] Stopping recording...");

    ffmpegProcess.on("close", (code) => {
      console.log(`[FFMPEG] Recording stopped with code ${code}`);
      resolve();
    });

    // Send SIGINT to stop gracefully
    ffmpegProcess.kill("SIGINT");

    // Fallback timeout
    setTimeout(() => {
      if (!ffmpegProcess.killed) {
        ffmpegProcess.kill("SIGKILL");
      }
      resolve();
    }, 5000);
  });
}

/**
 * Run the Python post-processing script (cursor overlay + speed adjustment)
 */
async function runPostProcessing(outputDir: string): Promise<void> {
  const pythonScript = `
import subprocess, os, sys, json

outdir = "${outputDir}"
events_log_path = f"{outdir}/events.log"

# Parse events.log for bounding_rect and pretool events
clicks = []  # list of (timestamp_ms, x, y)
recording_start_ms = None
last_bounding_rect = None

print(f"Reading events from {events_log_path}", file=sys.stderr)

# Parse events.log
line_count = 0
try:
    with open(events_log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            line_count += 1
            event = json.loads(line)
            ts = event.get("timestamp", 0)
            event_type = event.get("event", "")

            if event_type == "recording_start":
                if recording_start_ms is None:
                    recording_start_ms = ts
                    print(f"Found recording start at {ts}", file=sys.stderr)

            elif event_type == "bounding_rect":
                x = event.get("x", 0)
                y = event.get("y", 0)
                w = event.get("width", 0)
                h = event.get("height", 0)
                # Compute center and add browser chrome offset (85px)
                screen_x = int(x + w/2)
                screen_y = int(y + h/2 + 85)
                last_bounding_rect = (screen_x, screen_y, ts)
                print(f"bounding_rect: ({x},{y},{w},{h}) -> center=({screen_x}, {screen_y})", file=sys.stderr)

            elif event_type == "pretool":
                tool_name = event.get("tool", "").lower()
                uid = event.get("uid", "")
                if "click" in tool_name:
                    if last_bounding_rect:
                        clicks.append((ts, last_bounding_rect[0], last_bounding_rect[1]))
                        print(f"click (uid={uid}) at ({last_bounding_rect[0]}, {last_bounding_rect[1]}) ts={ts}", file=sys.stderr)
                    else:
                        print(f"WARNING: click without bounding_rect, tool={tool_name}, uid={uid}", file=sys.stderr)

    print(f"Processed {line_count} events", file=sys.stderr)
except FileNotFoundError:
    print(f"ERROR: events.log not found: {events_log_path}", file=sys.stderr)
except Exception as e:
    print(f"ERROR reading events.log: {e}", file=sys.stderr)

print(f"Found {len(clicks)} clicks", file=sys.stderr)

# Convert timestamps to relative time
if clicks:
    first_ts = clicks[0][0]
    clicks = [(0.5 + (ts - first_ts) / 1000.0, x, y) for ts, x, y in clicks]
    print(f"Adjusted clicks: {clicks}", file=sys.stderr)

if clicks:
    filters = []

    # Cursor starts at screen center and animates to first click position
    cx, cy = 960, 540
    first_t, first_x, first_y = clicks[0]
    anim_dur = max(first_t, 0.1)

    print(f"Animation: center ({cx},{cy}) -> ({first_x},{first_y}) over {anim_dur:.2f}s", file=sys.stderr)

    yo_x, yo_y = -14, -20
    bo_x, bo_y = -6, -12

    yellow_x_expr = f"({cx+yo_x}+({first_x+yo_x}-{cx+yo_x})*min(t/{anim_dur},1))"
    yellow_y_expr = f"({cy+yo_y}+({first_y+yo_y}-{cy+yo_y})*min(t/{anim_dur},1))"
    black_x_expr = f"({cx+bo_x}+({first_x+bo_x}-{cx+bo_x})*min(t/{anim_dur},1))"
    black_y_expr = f"({cy+bo_y}+({first_y+bo_y}-{cy+bo_y})*min(t/{anim_dur},1))"

    filters.append(f"drawtext=text='●':x='{yellow_x_expr}':y='{yellow_y_expr}':fontsize=36:fontcolor=yellow@0.5:enable='between(t,0,{anim_dur:.2f})'")
    filters.append(f"drawtext=text='●':x='{black_x_expr}':y='{black_y_expr}':fontsize=12:fontcolor=black:enable='between(t,0,{anim_dur:.2f})'")

    for i, (t, x, y) in enumerate(clicks):
        end_t = clicks[i+1][0] if i+1 < len(clicks) else 9999
        if end_t <= t:
            continue
        e = f"enable='between(t,{t:.2f},{end_t:.2f})'"
        filters.append(f"drawtext=text='●':x={x+yo_x}:y={y+yo_y}:fontsize=36:fontcolor=yellow@0.5:{e}")
        filters.append(f"drawtext=text='●':x={x+bo_x}:y={y+bo_y}:fontsize=12:fontcolor=black:{e}")

    filter_str = ",".join(filters)
    print(f"Drawing cursor overlay with {len(filters)} filter elements", file=sys.stderr)
    result = subprocess.run(f'ffmpeg -y -i "{outdir}/raw.mp4" -vf "{filter_str}" "{outdir}/with_cursor.mp4"', shell=True)
    if result.returncode != 0:
        print(f"Cursor overlay failed with code {result.returncode}", file=sys.stderr)
        os.rename(f"{outdir}/raw.mp4", f"{outdir}/workflow.mp4")
    else:
        os.remove(f"{outdir}/raw.mp4")

        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", f"{outdir}/with_cursor.mp4"],
            capture_output=True, text=True
        )
        video_duration = float(probe.stdout.strip()) if probe.stdout.strip() else 60.0
        print(f"Video duration: {video_duration:.1f}s", file=sys.stderr)

        FAST_SPEED = 4
        ACTION_BEFORE = 0.3
        ACTION_AFTER = 0.5

        video_segments = []
        prev_end = 0.0

        for t, x, y in clicks:
            action_start = max(0, t - ACTION_BEFORE)
            action_end = min(video_duration, t + ACTION_AFTER)

            if action_start > prev_end:
                video_segments.append((prev_end, action_start, FAST_SPEED))

            if video_segments and video_segments[-1][2] == 1 and action_start <= video_segments[-1][1]:
                video_segments[-1] = (video_segments[-1][0], action_end, 1)
            else:
                video_segments.append((action_start, action_end, 1))

            prev_end = action_end

        if prev_end < video_duration:
            video_segments.append((prev_end, video_duration, FAST_SPEED))

        print(f"Video segments: {video_segments}", file=sys.stderr)

        filter_parts = []
        concat_inputs = []
        for i, (start, end, speed) in enumerate(video_segments):
            pts = 1.0 / speed
            filter_parts.append(f"[0:v]trim=start={start}:end={end},setpts={pts}*(PTS-STARTPTS)[v{i}]")
            concat_inputs.append(f"[v{i}]")

        concat_filter = f"{''.join(concat_inputs)}concat=n={len(video_segments)}:v=1:a=0[out]"
        full_filter = ";".join(filter_parts) + ";" + concat_filter

        print(f"Applying variable speed: 1x during actions, {FAST_SPEED}x between", file=sys.stderr)
        speed_result = subprocess.run([
            "ffmpeg", "-y", "-i", f"{outdir}/with_cursor.mp4",
            "-filter_complex", full_filter,
            "-map", "[out]",
            f"{outdir}/workflow.mp4"
        ])

        if speed_result.returncode != 0:
            print(f"Variable speed failed, using cursor video as-is", file=sys.stderr)
            os.rename(f"{outdir}/with_cursor.mp4", f"{outdir}/workflow.mp4")
        else:
            os.remove(f"{outdir}/with_cursor.mp4")

        total_dur = sum((end - start) / speed for start, end, speed in video_segments)
        print(f"Final video: {len(video_segments)} segments, ~{total_dur:.1f}s (from {video_duration:.1f}s original)", file=sys.stderr)

else:
    print("No clicks found, speeding up raw video 4x", file=sys.stderr)
    result = subprocess.run(f'ffmpeg -y -i "{outdir}/raw.mp4" -vf "setpts=0.25*PTS" "{outdir}/workflow.mp4"', shell=True)
    if result.returncode == 0:
        os.remove(f"{outdir}/raw.mp4")
    else:
        os.rename(f"{outdir}/raw.mp4", f"{outdir}/workflow.mp4")

print("Post-processing complete!", file=sys.stderr)
`;

  console.log("[POST] Running post-processing script...");

  const { stdout, stderr } = await execAsync(`python3 << 'PYSCRIPT'
${pythonScript}
PYSCRIPT`);

  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

/**
 * Validate the output video exists and has expected properties
 */
async function validateOutput(outputDir: string): Promise<boolean> {
  const workflowPath = path.join(outputDir, "workflow.mp4");

  try {
    const stats = await fs.stat(workflowPath);
    console.log(`[VALIDATE] workflow.mp4 exists, size: ${(stats.size / 1024).toFixed(1)} KB`);

    // Get video duration
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${workflowPath}"`
    );
    const duration = parseFloat(stdout.trim());
    console.log(`[VALIDATE] Video duration: ${duration.toFixed(2)}s`);

    // Check trajectory.jsonl
    const trajectoryPath = path.join(outputDir, "trajectory.jsonl");
    const trajectoryStats = await fs.stat(trajectoryPath);
    console.log(`[VALIDATE] trajectory.jsonl exists, size: ${(trajectoryStats.size / 1024).toFixed(1)} KB`);

    // Check events.log
    const eventsPath = path.join(outputDir, "events.log");
    const eventsStats = await fs.stat(eventsPath);
    console.log(`[VALIDATE] events.log exists, size: ${(eventsStats.size / 1024).toFixed(1)} KB`);

    return true;
  } catch (err) {
    console.error(`[VALIDATE] Validation failed: ${err}`);
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  const outputDir = process.argv[2] || DEFAULT_OUTPUT_DIR;

  console.log("=".repeat(60));
  console.log("Video Pipeline Test Script");
  console.log("=".repeat(60));
  console.log(`Output directory: ${outputDir}`);
  console.log(`Display: ${DISPLAY}`);
  console.log(`Resolution: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);
  console.log("=".repeat(60));

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });

  // Check if DISPLAY is available
  try {
    await execAsync(`DISPLAY=${DISPLAY} xdpyinfo >/dev/null 2>&1`);
  } catch {
    console.error(`[ERROR] DISPLAY ${DISPLAY} is not available. Make sure X11 is running.`);
    console.log("[INFO] If running in a sandbox, ensure the display server is started.");
    process.exit(1);
  }

  let httpServer: http.Server | null = null;
  let ffmpegProcess: ReturnType<typeof spawn> | null = null;

  try {
    // Step 1: Start HTTP server
    console.log("\n[STEP 1] Starting HTTP server...");
    httpServer = await startHTTPServer();

    // Step 2: Open browser (using xdg-open or direct chromium)
    console.log("\n[STEP 2] Opening browser...");
    try {
      // Try to open in existing Chrome instance or start new one
      await execAsync(
        `DISPLAY=${DISPLAY} chromium --new-window "http://localhost:${HTTP_PORT}" >/dev/null 2>&1 &`
      );
    } catch {
      try {
        await execAsync(
          `DISPLAY=${DISPLAY} google-chrome --new-window "http://localhost:${HTTP_PORT}" >/dev/null 2>&1 &`
        );
      } catch {
        console.log("[WARN] Could not open browser automatically. Please open http://localhost:" + HTTP_PORT);
      }
    }

    // Wait for browser to load
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 3: Start recording
    console.log("\n[STEP 3] Starting ffmpeg recording...");
    const recordingStartTime = Date.now();
    const { process: ffmpeg } = await startFFmpegRecording(outputDir);
    ffmpegProcess = ffmpeg;

    // Step 4: Generate fake events and trajectory
    console.log("\n[STEP 4] Generating fake trajectory and events...");
    await generateFakeEventsLog(outputDir, recordingStartTime);
    await generateFakeTrajectory(outputDir, recordingStartTime);

    // Step 5: Record for a few seconds (simulate clicks happening)
    const totalClickTime = FAKE_CLICKS.reduce((sum, c) => sum + c.delayMs, 0);
    const recordDuration = Math.max(5000, totalClickTime + 2000);
    console.log(`\n[STEP 5] Recording for ${recordDuration / 1000}s (simulating clicks)...`);
    await new Promise((resolve) => setTimeout(resolve, recordDuration));

    // Step 6: Stop recording
    console.log("\n[STEP 6] Stopping recording...");
    await stopFFmpegRecording(ffmpegProcess);
    ffmpegProcess = null;

    // Step 7: Run post-processing
    console.log("\n[STEP 7] Running post-processing (cursor overlay + speed adjustment)...");
    await runPostProcessing(outputDir);

    // Step 8: Validate output
    console.log("\n[STEP 8] Validating output...");
    const isValid = await validateOutput(outputDir);

    console.log("\n" + "=".repeat(60));
    if (isValid) {
      console.log("✅ TEST PASSED!");
      console.log(`Output files in: ${outputDir}`);
      console.log("  - workflow.mp4 (final video with cursor overlay)");
      console.log("  - trajectory.jsonl (agent messages)");
      console.log("  - events.log (click events for cursor rendering)");
    } else {
      console.log("❌ TEST FAILED!");
      process.exit(1);
    }
    console.log("=".repeat(60));

  } catch (error) {
    console.error(`\n[ERROR] Test failed: ${error}`);
    process.exit(1);
  } finally {
    // Cleanup
    if (httpServer) {
      httpServer.close();
      console.log("[CLEANUP] HTTP server stopped");
    }
    if (ffmpegProcess) {
      ffmpegProcess.kill("SIGKILL");
      console.log("[CLEANUP] FFmpeg process killed");
    }
  }
}

// Run if executed directly
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
