import type { CommandInput, FrameRate, Project, Transcript } from "../../src/schema.ts";
import type { ActivityEntry } from "../../src/engine.ts";
import type { Job } from "../../src/jobs.ts";
import type { AgentStatus } from "../../src/mcp/presence.ts";
import type { MediaListing } from "../../src/mcp/workspace.ts";

export type { ActivityEntry, AgentStatus, Job, MediaListing };

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "Không kết nối được tới server. Hãy kiểm tra server còn chạy không rồi thử lại.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? `Server trả về lỗi ${response.status}.`, data.code);
  }
  return data as T;
}

export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  width: number;
  height: number;
  fps: FrameRate;
  assetCount: number;
  durationFrames: number;
  modifiedAt: string;
}

export interface ProjectState {
  project: Project;
  undoLabel?: string;
  redoLabel?: string;
  activity: ActivityEntry[];
}

/** What the server pushes over the project's WebSocket. */
export type ProjectEvent =
  | { type: "snapshot"; state: ProjectState; jobs: Job[]; agent: AgentStatus }
  | { type: "state"; state: ProjectState }
  | { type: "job"; job: Job }
  | { type: "agent"; agent: AgentStatus };

export interface ImportCheck {
  name: string;
  path: string;
  width: number;
  height: number;
  sourceFps: number;
  projectFps: number;
  reasons: string[];
  warning?: string;
}

const base = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const api = {
  listProjects: () => request<ProjectSummary[]>("/projects"),
  createProject: (body: { id: string; name: string; width: number; height: number; fps: FrameRate; folder?: string }) =>
    request<ProjectState & { id: string }>("/projects", body),
  getProject: (id: string) => request<ProjectState>(base(id)),
  batch: (id: string, baseRevision: number, label: string, commands: CommandInput[]) =>
    request<ProjectState & { createdClipIds: string[] }>(`${base(id)}/batch`, { baseRevision, label, commands }),
  undo: (id: string, baseRevision: number) => request<ProjectState>(`${base(id)}/undo`, { baseRevision }),
  redo: (id: string, baseRevision: number) => request<ProjectState>(`${base(id)}/redo`, { baseRevision }),
  revert: (id: string, baseRevision: number, revision: number) =>
    request<ProjectState>(`${base(id)}/revert`, { baseRevision, revision }),
  browseProjectMedia: (id: string) => request<MediaListing>(`/media?project=${encodeURIComponent(id)}`),
  browseMedia: (path?: string) =>
    request<MediaListing>(`/media${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  checkImport: (id: string, path: string) => request<ImportCheck>(`${base(id)}/import/check`, { path }),
  startImport: (id: string, path: string) => request<Job>(`${base(id)}/import`, { path }),
  cancelJob: (id: string, jobId: string) => request<Job>(`${base(id)}/jobs/${jobId}/cancel`, {}),
  dismissJob: (id: string, jobId: string) => request<object>(`${base(id)}/jobs/${jobId}/dismiss`, {}),
  startExport: (id: string, name: string) => request<Job>(`${base(id)}/export`, { name }),
  peaks: (id: string, assetId: string) => request<number[]>(`${base(id)}/assets/${assetId}/peaks`),
  transcript: (id: string, assetId: string) => request<{ transcript: Transcript | null }>(`${base(id)}/assets/${assetId}/transcript`),
  startTranscribe: (id: string, assetId: string, language: string) => request<Job>(`${base(id)}/assets/${assetId}/transcribe`, { language }),
};

export const urls = {
  events: (id: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api${base(id)}/events`,
  proxy: (id: string, assetId: string) => `/api${base(id)}/assets/${assetId}/proxy`,
  thumbnail: (id: string, assetId: string, frame: number) => `/api${base(id)}/assets/${assetId}/thumbnail?frame=${frame}`,
  /** version changes with the text and its look, so the browser never shows an old picture. */
  textImage: (id: string, clipId: string, version: string) => `/api${base(id)}/clips/${clipId}/text-image?v=${version}`,
  exportFile: (id: string, name: string) => `/api${base(id)}/exports/${encodeURIComponent(name)}`,
};
