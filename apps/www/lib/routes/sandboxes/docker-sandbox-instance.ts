import type Docker from "dockerode";
import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";

export class DockerSandboxInstance implements SandboxInstance {
  readonly id: string;
  private container: Docker.Container;

  constructor(container: Docker.Container, id: string) {
    this.container = container;
    this.id = id;
  }

  async exec(command: string): Promise<SandboxExecResult> {
    const exec = await this.container.exec({
      Cmd: ["bash", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
    });

    return new Promise<SandboxExecResult>((resolve, reject) => {
      exec.start(
        {},
        (err: Error | null, stream?: NodeJS.ReadableStream) => {
          if (err) {
            reject(err);
            return;
          }
          if (!stream) {
            resolve({ exit_code: 1, stdout: "", stderr: "No stream returned" });
            return;
          }

          // Collect demuxed stdout/stderr from Docker multiplexed stream
          const stdoutChunks: Buffer[] = [];
          const stderrChunks: Buffer[] = [];

          stream.on("data", (chunk: Buffer) => {
            // Docker multiplexed stream: first 8 bytes are header
            // byte 0: stream type (1=stdout, 2=stderr)
            // bytes 4-7: payload size (big-endian uint32)
            let offset = 0;
            while (offset < chunk.length) {
              if (offset + 8 > chunk.length) {
                // Incomplete header, treat rest as stdout
                stdoutChunks.push(chunk.subarray(offset));
                break;
              }
              const streamType = chunk[offset];
              const payloadSize = chunk.readUInt32BE(offset + 4);
              const payload = chunk.subarray(offset + 8, offset + 8 + payloadSize);

              if (streamType === 2) {
                stderrChunks.push(payload);
              } else {
                stdoutChunks.push(payload);
              }
              offset += 8 + payloadSize;
            }
          });

          stream.on("end", () => {
            exec.inspect().then(
              (info) => {
                resolve({
                  exit_code: info.ExitCode ?? 1,
                  stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                  stderr: Buffer.concat(stderrChunks).toString("utf-8"),
                });
              },
              (inspectErr) => {
                console.error(
                  "[DockerSandboxInstance] Failed to inspect exec:",
                  inspectErr,
                );
                resolve({
                  exit_code: 1,
                  stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                  stderr: Buffer.concat(stderrChunks).toString("utf-8"),
                });
              },
            );
          });

          stream.on("error", (streamErr) => {
            reject(streamErr);
          });
        },
      );
    });
  }

  async stop(): Promise<void> {
    try {
      await this.container.stop();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 304) {
        throw error;
      }
      // 304 = already stopped, that's fine
    }
  }
}
