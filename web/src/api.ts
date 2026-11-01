import type { CommandInput, FrameRate, Project } from "../../src/schema.ts";
import type { Job } from "../../src/jobs.ts";
import type { MediaListing } from "../../src/mcp/workspace.ts";

export type { Job, MediaListing };

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
}

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
  createProject: (body: { id: string; name: string; width: number; height: number }) =>
    request<ProjectState & { id: string }>("/projects", body),
  getProject: (id: string) => request<ProjectState>(base(id)),
  status: (id: string) => request<{ revision: number; jobs: Job[] }>(`${base(id)}/status`),
  batch: (id: string, baseRevision: number, label: string, commands: CommandInput[]) =>
    request<ProjectState & { createdClipIds: string[] }>(`${base(id)}/batch`, { baseRevision, label, commands }),
  undo: (id: string, baseRevision: number) => request<ProjectState>(`${base(id)}/undo`, { baseRevision }),
  redo: (id: string, baseRevision: number) => request<ProjectState>(`${base(id)}/redo`, { baseRevision }),
  browseMedia: (path?: string) =>
    request<MediaListing>(`/media${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  checkImport: (id: string, path: string) => request<ImportCheck>(`${base(id)}/import/check`, { path }),
  startImport: (id: string, path: string) => request<Job>(`${base(id)}/import`, { path }),
  startExport: (id: string, name: string) => request<Job>(`${base(id)}/export`, { name }),
  peaks: (id: string, assetId: string) => request<number[]>(`${base(id)}/assets/${assetId}/peaks`),
};

export const urls = {
  proxy: (id: string, assetId: string) => `/api${base(id)}/assets/${assetId}/proxy`,
  thumbnail: (id: string, assetId: string, frame: number) => `/api${base(id)}/assets/${assetId}/thumbnail?frame=${frame}`,
  exportFile: (id: string, name: string) => `/api${base(id)}/exports/${encodeURIComponent(name)}`,
};
