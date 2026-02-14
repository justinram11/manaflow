export interface SandboxExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface SandboxInstance {
  readonly id: string;
  exec(command: string): Promise<SandboxExecResult>;
  stop(): Promise<void>;
}
