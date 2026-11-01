import { spawn } from "node:child_process";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a binary with an argument list, never through a shell, so paths need no escaping. */
export function run(binary: string, args: string[], onStdout?: (chunk: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (onStdout) onStdout(chunk.toString());
      else stdout.push(chunk);
    });
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

/** Reports the number of frames written so far. */
export function ffmpegWithProgress(args: string[], onFrame: (frame: number) => void): Promise<RunResult> {
  return run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", ...args], (chunk) => {
    for (const match of chunk.matchAll(/^frame=\s*(\d+)/gm)) onFrame(Number(match[1]));
  });
}

export function ffprobe(args: string[]): Promise<RunResult> {
  return run("ffprobe", ["-v", "error", ...args]);
}
