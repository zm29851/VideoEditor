import { spawn } from "node:child_process";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a binary with an argument list, never through a shell, so paths need no escaping. */
export function run(binary: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else reject(new Error(`${binary} thoát với mã ${code}:\n${stderr}`));
    });
  });
}

export function ffmpeg(args: string[]): Promise<RunResult> {
  return run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args]);
}

export function ffprobe(args: string[]): Promise<RunResult> {
  return run("ffprobe", ["-v", "error", ...args]);
}
