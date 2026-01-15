import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface ActiveRecording {
  process: ChildProcess;
  outputPath: string;
  startTime: number;
}

const activeRecordings = new Map<string, ActiveRecording>();

const VIDEO_OUTPUT_DIR = process.env.VIDEO_OUTPUT_DIR || "/root/screenshots";
const DISPLAY = process.env.DISPLAY || ":99";

async function ensureOutputDir(): Promise<void> {
  await fs.mkdir(VIDEO_OUTPUT_DIR, { recursive: true });
}

function generateVideoPath(name: string): string {
  const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const timestamp = Date.now();
  return path.join(VIDEO_OUTPUT_DIR, `${sanitizedName}-${timestamp}.mp4`);
}

async function startVideoRecording(name: string): Promise<{ success: boolean; message: string; recordingId?: string }> {
  if (activeRecordings.has(name)) {
    return {
      success: false,
      message: `Recording with name "${name}" is already in progress`,
    };
  }

  await ensureOutputDir();
  const outputPath = generateVideoPath(name);

  // Use ffmpeg to record the X11 display
  // -y: overwrite output file
  // -f x11grab: capture X11 display
  // -video_size: capture resolution (will be adjusted by ffmpeg if needed)
  // -framerate: frames per second
  // -i: input (display)
  // -c:v libx264: H.264 codec
  // -preset ultrafast: fast encoding for real-time recording
  // -crf 23: quality (lower = better, 18-28 is reasonable range)
  const ffmpegArgs = [
    "-y",
    "-f", "x11grab",
    "-video_size", "1920x1080",
    "-framerate", "30",
    "-i", DISPLAY,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];

  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  let stderrOutput = "";

  ffmpegProcess.stderr?.on("data", (data) => {
    stderrOutput += data.toString();
  });

  // Wait a short time to make sure ffmpeg starts successfully
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (ffmpegProcess.exitCode === null) {
        // Process is still running, which is good
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${ffmpegProcess.exitCode}: ${stderrOutput}`));
      }
    }, 1000);

    ffmpegProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ffmpegProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput}`));
      }
    });
  });

  activeRecordings.set(name, {
    process: ffmpegProcess,
    outputPath,
    startTime: Date.now(),
  });

  return {
    success: true,
    message: `Started recording "${name}" to ${outputPath}`,
    recordingId: name,
  };
}

async function endVideoRecording(name: string): Promise<{ success: boolean; message: string; videoPath?: string; durationMs?: number }> {
  const recording = activeRecordings.get(name);

  if (!recording) {
    return {
      success: false,
      message: `No active recording found with name "${name}"`,
    };
  }

  const { process: ffmpegProcess, outputPath, startTime } = recording;
  const durationMs = Date.now() - startTime;

  // Send 'q' to ffmpeg's stdin to gracefully stop recording
  // This allows ffmpeg to properly finalize the video file
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // If ffmpeg doesn't respond to 'q', force kill it
      ffmpegProcess.kill("SIGKILL");
    }, 5000);

    ffmpegProcess.on("exit", async () => {
      clearTimeout(timeout);
      activeRecordings.delete(name);

      // Verify the file exists
      try {
        await fs.access(outputPath);
        resolve({
          success: true,
          message: `Recording "${name}" saved successfully`,
          videoPath: outputPath,
          durationMs,
        });
      } catch {
        resolve({
          success: false,
          message: `Recording stopped but video file not found at ${outputPath}`,
        });
      }
    });

    // Send 'q' to gracefully stop ffmpeg
    if (ffmpegProcess.stdin) {
      ffmpegProcess.stdin.write("q");
      ffmpegProcess.stdin.end();
    } else {
      // Fallback to SIGINT if stdin is not available
      ffmpegProcess.kill("SIGINT");
    }
  });
}

async function main(): Promise<void> {
  const server = new Server(
    {
      name: "video-recording-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "start_video",
          description: `Start recording a video of the screen. Use this for end-to-end workflow demonstrations where you need to show a before/after sequence or a multi-step interaction that's better captured as video than static screenshots. The recording captures the browser display.

WHEN TO USE VIDEO:
- Before/after workflows: Start recording, perform the "before" action, then the "after" action, then stop
- Multi-step interactions: Login flows, form submissions with validation, drag-and-drop operations
- Animations or transitions that don't capture well in screenshots
- Complex UI state changes that happen in sequence

WHEN NOT TO USE VIDEO (use screenshots instead):
- Simple static UI changes (button style, color, text changes)
- Single component states (hover, active, disabled)
- Layout changes that can be shown in a single image

Returns a recording ID that must be passed to end_video to stop recording.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              name: {
                type: "string",
                description: "A descriptive name for the recording (e.g., 'login-flow', 'checkout-process', 'drag-drop-demo'). This will be used in the output filename.",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "end_video",
          description: `Stop an active video recording and save the video file. Call this after completing the workflow demonstration. The video will be saved to the output directory with the recording name in the filename.

Always call this after start_video to ensure the video is properly saved. The recording should capture the complete workflow from start to finish.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              name: {
                type: "string",
                description: "The recording name that was passed to start_video",
              },
            },
            required: ["name"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "start_video") {
      const recordingName = (args as { name: string }).name;
      const result = await startVideoRecording(recordingName);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === "end_video") {
      const recordingName = (args as { name: string }).name;
      const result = await endVideoRecording(recordingName);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Unknown tool: ${name}`,
        },
      ],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
