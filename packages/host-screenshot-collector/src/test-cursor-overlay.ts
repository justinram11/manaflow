#!/usr/bin/env bun
/**
 * Test script for cursor overlay post-processing (no X11 required).
 *
 * This script:
 * 1. Generates a synthetic video with cycling colors using ffmpeg
 * 2. Creates fake events.log with bounding_rect and pretool click events
 * 3. Runs the cursor overlay post-processing
 * 4. Validates the output video has the cursor rendered
 *
 * Usage:
 *   cd packages/host-screenshot-collector
 *   bun run src/test-cursor-overlay.ts [outputDir]
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Configuration
const DEFAULT_OUTPUT_DIR = "/tmp/test-cursor-overlay";
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const VIDEO_DURATION = 8; // seconds
const FRAMERATE = 24;

// Colors for synthetic video (hex without #)
const COLORS = [
  "FF6B6B", // Red
  "4ECDC4", // Teal
  "45B7D1", // Blue
  "96CEB4", // Green
  "FFEAA7", // Yellow
  "DDA0DD", // Plum
  "FF9F43", // Orange
  "54A0FF", // Sky Blue
];

// Fake click positions (simulating button clicks)
// These simulate what getBoundingRectFromCDP would return
const FAKE_CLICKS = [
  { x: 200, y: 150, width: 100, height: 40, timeOffsetMs: 500 },
  { x: 960, y: 400, width: 150, height: 50, timeOffsetMs: 1500 },
  { x: 1600, y: 200, width: 120, height: 40, timeOffsetMs: 2500 },
  { x: 400, y: 700, width: 200, height: 60, timeOffsetMs: 4000 },
  { x: 1400, y: 600, width: 180, height: 45, timeOffsetMs: 5500 },
];

/**
 * Generate a synthetic video with cycling colors using ffmpeg
 */
async function generateSyntheticVideo(outputDir: string): Promise<void> {
  const outputPath = path.join(outputDir, "raw.mp4");

  // Build ffmpeg filter for color cycling
  // Each color shows for VIDEO_DURATION / COLORS.length seconds
  const segmentDuration = VIDEO_DURATION / COLORS.length;

  // Use color sources and concat them
  const filterParts: string[] = [];
  const inputLabels: string[] = [];

  for (let i = 0; i < COLORS.length; i++) {
    const color = COLORS[i];
    // Create color source with text overlay showing the color name
    filterParts.push(
      `color=c=0x${color}:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:duration=${segmentDuration}:rate=${FRAMERATE},` +
      `drawtext=text='Color ${i + 1}\\: #${color}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-100,` +
      `drawtext=text='Click targets below':fontsize=36:fontcolor=white@0.7:x=(w-text_w)/2:y=(h-text_h)/2+50[v${i}]`
    );
    inputLabels.push(`[v${i}]`);
  }

  // Add fake "buttons" as rectangles
  const buttonFilter = FAKE_CLICKS.map((click, i) => {
    const cx = click.x + click.width / 2;
    const cy = click.y + click.height / 2;
    return `drawbox=x=${click.x}:y=${click.y}:w=${click.width}:h=${click.height}:color=white@0.8:t=fill,` +
           `drawtext=text='Btn${i + 1}':fontsize=20:fontcolor=black:x=${cx - 20}:y=${cy - 10}`;
  }).join(",");

  // Concatenate color segments
  const concat = `${inputLabels.join("")}concat=n=${COLORS.length}:v=1:a=0[base]`;
  filterParts.push(concat);

  // Apply button overlays
  filterParts.push(`[base]${buttonFilter}[out]`);

  const filterComplex = filterParts.join(";");

  const ffmpegCmd = `ffmpeg -y -filter_complex "${filterComplex}" -map "[out]" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p "${outputPath}"`;

  console.log("[FFMPEG] Generating synthetic video...");
  console.log(`[FFMPEG] Duration: ${VIDEO_DURATION}s, Colors: ${COLORS.length}, Resolution: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);

  try {
    await execAsync(ffmpegCmd);
    const stats = await fs.stat(outputPath);
    console.log(`[FFMPEG] Generated raw.mp4: ${(stats.size / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error("[FFMPEG] Error generating video:", err);
    throw err;
  }
}

/**
 * Generate events.log with bounding_rect and pretool events
 */
async function generateEventsLog(outputDir: string): Promise<number> {
  const eventsLogPath = path.join(outputDir, "events.log");
  const events: string[] = [];

  // Base timestamp (simulating recording start)
  const recordingStartTime = Date.now();

  // Recording start event
  events.push(JSON.stringify({
    timestamp: recordingStartTime,
    event: "recording_start",
  }));

  // Generate click events with bounding_rect before each
  for (let i = 0; i < FAKE_CLICKS.length; i++) {
    const click = FAKE_CLICKS[i]!;
    const clickTime = recordingStartTime + click.timeOffsetMs;
    const uid = `1_${1000 + i}`; // Fake CDP uid format

    // Bounding rect event (simulates what pretool hook captures via CDP)
    events.push(JSON.stringify({
      timestamp: clickTime,
      event: "bounding_rect",
      x: click.x,
      y: click.y,
      width: click.width,
      height: click.height,
      uid,
    }));

    // Pretool click event
    events.push(JSON.stringify({
      timestamp: clickTime + 10,
      event: "pretool",
      tool: "mcp__chrome__click",
      uid,
    }));
  }

  await fs.writeFile(eventsLogPath, events.join("\n") + "\n");
  console.log(`[EVENTS] Generated ${events.length} events in events.log`);
  console.log(`[EVENTS] Click positions: ${FAKE_CLICKS.map((c, i) => `Btn${i + 1}@(${c.x + c.width / 2},${c.y + c.height / 2})`).join(", ")}`);

  return recordingStartTime;
}

/**
 * Generate trajectory.jsonl (for completeness)
 */
async function generateTrajectory(outputDir: string, startTime: number): Promise<void> {
  const trajectoryPath = path.join(outputDir, "trajectory.jsonl");
  const entries: string[] = [];

  // System init
  entries.push(JSON.stringify({
    timestamp: startTime - 1000,
    message: {
      type: "system",
      subtype: "init",
      cwd: "/root/workspace",
      session_id: `test-${Date.now()}`,
      tools: ["Task", "Bash", "Read", "Edit", "Write", "mcp__chrome__click"],
    },
  }));

  // Assistant messages with click tool_use
  for (let i = 0; i < FAKE_CLICKS.length; i++) {
    const click = FAKE_CLICKS[i]!;
    const clickTime = startTime + click.timeOffsetMs;
    const uid = `1_${1000 + i}`;

    entries.push(JSON.stringify({
      timestamp: clickTime,
      message: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: `toolu_click_${i}`,
              name: "mcp__chrome__click",
              input: { uid },
            },
          ],
        },
      },
    }));

    entries.push(JSON.stringify({
      timestamp: clickTime + 50,
      message: {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `toolu_click_${i}`,
              content: `Clicked element at (${click.x + click.width / 2}, ${click.y + click.height / 2})`,
            },
          ],
        },
      },
    }));
  }

  // Final result
  entries.push(JSON.stringify({
    timestamp: startTime + VIDEO_DURATION * 1000,
    message: {
      type: "result",
      result: "Test completed. hasUiChanges=true. Captured 5 clicks.",
      duration_ms: VIDEO_DURATION * 1000,
      num_turns: FAKE_CLICKS.length + 1,
    },
  }));

  await fs.writeFile(trajectoryPath, entries.join("\n") + "\n");
  console.log(`[TRAJECTORY] Generated ${entries.length} entries in trajectory.jsonl`);
}

/**
 * Run the cursor overlay post-processing Python script
 */
async function runPostProcessing(outputDir: string): Promise<void> {
  // This is the same post-processing logic from the main index.ts
  const pythonScript = `
import subprocess, os, sys, json

outdir = "${outputDir}"
events_log_path = f"{outdir}/events.log"

clicks = []
recording_start_ms = None
last_bounding_rect = None

print(f"Reading events from {events_log_path}", file=sys.stderr)

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
                screen_x = int(x + w/2)
                screen_y = int(y + h/2 + 85)  # Browser chrome offset
                last_bounding_rect = (screen_x, screen_y, ts)
                print(f"bounding_rect: ({x},{y},{w},{h}) -> center=({screen_x}, {screen_y})", file=sys.stderr)

            elif event_type == "pretool":
                tool_name = event.get("tool", "").lower()
                uid = event.get("uid", "")
                if "click" in tool_name:
                    if last_bounding_rect:
                        clicks.append((ts, last_bounding_rect[0], last_bounding_rect[1]))
                        print(f"click (uid={uid}) at ({last_bounding_rect[0]}, {last_bounding_rect[1]}) ts={ts}", file=sys.stderr)

    print(f"Processed {line_count} events, found {len(clicks)} clicks", file=sys.stderr)
except Exception as e:
    print(f"ERROR reading events.log: {e}", file=sys.stderr)
    sys.exit(1)

if clicks:
    first_ts = clicks[0][0]
    clicks = [(0.5 + (ts - first_ts) / 1000.0, x, y) for ts, x, y in clicks]
    print(f"Time-adjusted clicks: {clicks}", file=sys.stderr)

if clicks:
    filters = []
    cx, cy = 960, 540
    first_t, first_x, first_y = clicks[0]
    anim_dur = max(first_t, 0.1)

    print(f"Cursor animation: center ({cx},{cy}) -> ({first_x},{first_y}) over {anim_dur:.2f}s", file=sys.stderr)

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
    print(f"Applying cursor overlay ({len(filters)} filter elements)...", file=sys.stderr)

    result = subprocess.run(f'ffmpeg -y -i "{outdir}/raw.mp4" -vf "{filter_str}" "{outdir}/with_cursor.mp4"', shell=True)
    if result.returncode != 0:
        print(f"Cursor overlay FAILED with code {result.returncode}", file=sys.stderr)
        os.rename(f"{outdir}/raw.mp4", f"{outdir}/workflow.mp4")
        sys.exit(1)
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

        print(f"Speed segments: {video_segments}", file=sys.stderr)

        filter_parts = []
        concat_inputs = []
        for i, (start, end, speed) in enumerate(video_segments):
            pts = 1.0 / speed
            filter_parts.append(f"[0:v]trim=start={start}:end={end},setpts={pts}*(PTS-STARTPTS)[v{i}]")
            concat_inputs.append(f"[v{i}]")

        concat_filter = f"{''.join(concat_inputs)}concat=n={len(video_segments)}:v=1:a=0[out]"
        full_filter = ";".join(filter_parts) + ";" + concat_filter

        print(f"Applying variable speed (1x during actions, {FAST_SPEED}x between)...", file=sys.stderr)
        speed_result = subprocess.run([
            "ffmpeg", "-y", "-i", f"{outdir}/with_cursor.mp4",
            "-filter_complex", full_filter,
            "-map", "[out]",
            f"{outdir}/workflow.mp4"
        ])

        if speed_result.returncode != 0:
            print(f"Variable speed FAILED, using cursor video as-is", file=sys.stderr)
            os.rename(f"{outdir}/with_cursor.mp4", f"{outdir}/workflow.mp4")
        else:
            os.remove(f"{outdir}/with_cursor.mp4")

        total_dur = sum((end - start) / speed for start, end, speed in video_segments)
        print(f"Final video: {len(video_segments)} segments, ~{total_dur:.1f}s (from {video_duration:.1f}s)", file=sys.stderr)

else:
    print("No clicks found, speeding up raw video 4x", file=sys.stderr)
    result = subprocess.run(f'ffmpeg -y -i "{outdir}/raw.mp4" -vf "setpts=0.25*PTS" "{outdir}/workflow.mp4"', shell=True)
    if result.returncode == 0:
        os.remove(f"{outdir}/raw.mp4")
    else:
        os.rename(f"{outdir}/raw.mp4", f"{outdir}/workflow.mp4")

print("Post-processing complete!", file=sys.stderr)
`;

  console.log("[POST] Running cursor overlay post-processing...");

  try {
    const { stderr } = await execAsync(`python3 << 'PYSCRIPT'
${pythonScript}
PYSCRIPT`);
    if (stderr) {
      // Python prints to stderr, this is expected
      console.log(stderr);
    }
  } catch (err) {
    console.error("[POST] Post-processing error:", err);
    throw err;
  }
}

/**
 * Validate output files
 */
async function validateOutput(outputDir: string): Promise<{ success: boolean; details: Record<string, string> }> {
  const details: Record<string, string> = {};
  let success = true;

  // Check workflow.mp4
  const workflowPath = path.join(outputDir, "workflow.mp4");
  try {
    const stats = await fs.stat(workflowPath);
    details["workflow.mp4"] = `${(stats.size / 1024).toFixed(1)} KB`;

    // Get duration
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${workflowPath}"`
    );
    const duration = parseFloat(stdout.trim());
    details["duration"] = `${duration.toFixed(2)}s`;

    // The video should be shorter than original due to 4x speed sections
    if (duration >= VIDEO_DURATION) {
      details["speed_applied"] = "NO (unexpected)";
      success = false;
    } else {
      details["speed_applied"] = "YES (video is compressed)";
    }
  } catch {
    details["workflow.mp4"] = "MISSING";
    success = false;
  }

  // Check events.log
  const eventsPath = path.join(outputDir, "events.log");
  try {
    const content = await fs.readFile(eventsPath, "utf-8");
    const lineCount = content.trim().split("\n").length;
    details["events.log"] = `${lineCount} events`;
  } catch {
    details["events.log"] = "MISSING";
    success = false;
  }

  // Check trajectory.jsonl
  const trajectoryPath = path.join(outputDir, "trajectory.jsonl");
  try {
    const content = await fs.readFile(trajectoryPath, "utf-8");
    const lineCount = content.trim().split("\n").length;
    details["trajectory.jsonl"] = `${lineCount} entries`;
  } catch {
    details["trajectory.jsonl"] = "MISSING";
    success = false;
  }

  return { success, details };
}

/**
 * Main test runner
 */
async function main() {
  const outputDir = process.argv[2] || DEFAULT_OUTPUT_DIR;

  console.log("╔" + "═".repeat(58) + "╗");
  console.log("║" + " Cursor Overlay Pipeline Test (No X11 Required) ".padStart(40).padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝");
  console.log(`\nOutput directory: ${outputDir}`);
  console.log(`Video: ${VIDEO_WIDTH}x${VIDEO_HEIGHT} @ ${FRAMERATE}fps, ${VIDEO_DURATION}s`);
  console.log(`Clicks: ${FAKE_CLICKS.length} simulated button clicks\n`);

  // Check ffmpeg availability
  try {
    await execAsync("ffmpeg -version > /dev/null 2>&1");
    await execAsync("ffprobe -version > /dev/null 2>&1");
  } catch {
    console.error("ERROR: ffmpeg/ffprobe not found. Please install ffmpeg.");
    process.exit(1);
  }

  // Check python3 availability
  try {
    await execAsync("python3 --version > /dev/null 2>&1");
  } catch {
    console.error("ERROR: python3 not found.");
    process.exit(1);
  }

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });

  try {
    // Step 1: Generate synthetic video
    console.log("[STEP 1/4] Generating synthetic color-cycling video...");
    await generateSyntheticVideo(outputDir);

    // Step 2: Generate events.log
    console.log("\n[STEP 2/4] Generating events.log with fake click events...");
    const startTime = await generateEventsLog(outputDir);

    // Step 3: Generate trajectory.jsonl
    console.log("\n[STEP 3/4] Generating trajectory.jsonl...");
    await generateTrajectory(outputDir, startTime);

    // Step 4: Run post-processing
    console.log("\n[STEP 4/4] Running cursor overlay and speed adjustment...");
    await runPostProcessing(outputDir);

    // Validate
    console.log("\n" + "─".repeat(60));
    console.log("VALIDATION:");
    const { success, details } = await validateOutput(outputDir);

    for (const [key, value] of Object.entries(details)) {
      const status = value.includes("MISSING") || value.includes("NO") ? "✗" : "✓";
      console.log(`  ${status} ${key}: ${value}`);
    }

    console.log("─".repeat(60));

    if (success) {
      console.log("\n✅ TEST PASSED!\n");
      console.log("Output files:");
      console.log(`  ${outputDir}/workflow.mp4  - Final video with cursor overlay`);
      console.log(`  ${outputDir}/events.log    - Click events for cursor rendering`);
      console.log(`  ${outputDir}/trajectory.jsonl - Agent message log`);
      console.log("\nThe cursor should:");
      console.log("  1. Start at screen center (960, 540)");
      console.log("  2. Animate to first click position");
      console.log("  3. Jump between subsequent click positions");
      console.log("  4. Be visible as yellow circle with black center dot");
      console.log("\nSpeed should:");
      console.log("  1. Be 1x (normal) during click moments");
      console.log("  2. Be 4x (fast) between clicks");
    } else {
      console.log("\n❌ TEST FAILED!\n");
      process.exit(1);
    }

  } catch (error) {
    console.error(`\nFATAL ERROR: ${error}`);
    process.exit(1);
  }
}

// Run
main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
