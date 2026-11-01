import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { z, ZodError } from "zod";
import { CommandError } from "../commands.ts";
import { StaleRevisionError, type CommandEngine } from "../engine.ts";
import { timelineDuration } from "../media/export.ts";
import { extractFrame } from "../media/frames.ts";
import { judderWarning, normalizationReasons } from "../media/import.ts";
import { loadPeaks } from "../media/peaks.ts";
import { probeMedia } from "../media/probe.ts";
import { projectPaths } from "../store.ts";
import { fpsToNumber } from "../time.ts";
import type { Workspace } from "../mcp/workspace.ts";
import { sendFile } from "./static.ts";

const ACTOR = "user";
const THUMBNAIL_EDGE = 320;

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

/** The whole state the editor needs after any change, so it never has to guess what changed. */
function projectState(engine: CommandEngine): object {
  return { project: engine.project, undoLabel: engine.undoLabel, redoLabel: engine.redoLabel };
}

const CreateProject = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(100),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(7680),
});
const Batch = z.object({
  baseRevision: z.number().int().nonnegative(),
  label: z.string().min(1).max(200),
  commands: z.array(z.unknown()),
});
const Revision = z.object({ baseRevision: z.number().int().nonnegative() });
const MediaPath = z.object({ path: z.string().min(1) });
const ExportRequest = z.object({ name: z.string() });

function engineOf(workspace: Workspace, projectId: string): CommandEngine {
  try {
    return workspace.engine(projectId);
  } catch (error) {
    throw new ApiError(404, error instanceof Error ? error.message : "Không có project này.");
  }
}

function assetOf(engine: CommandEngine, assetId: string) {
  const asset = engine.project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new ApiError(404, `Không có video "${assetId}" trong project.`);
  return asset;
}

function listProjects(workspace: Workspace): object[] {
  return workspace
    .list()
    .map((id) => {
      const project = workspace.engine(id).project;
      return {
        id,
        name: project.name,
        width: project.width,
        height: project.height,
        fps: project.fps,
        assetCount: project.assets.length,
        durationFrames: timelineDuration(project),
        modifiedAt: statSync(projectPaths(workspace.projectRoot(id)).project).mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function route(
  workspace: Workspace,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<void> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);

  if (parts[0] === "media" && parts.length === 1 && method === "GET") {
    return sendJson(res, 200, workspace.browseMedia(url.searchParams.get("path") ?? undefined));
  }

  if (parts[0] !== "projects") throw new ApiError(404, "Không có đường dẫn này.");

  if (parts.length === 1) {
    if (method === "GET") return sendJson(res, 200, listProjects(workspace));
    if (method === "POST") {
      const body = CreateProject.parse(await readBody());
      if (workspace.list().includes(body.id)) throw new ApiError(409, `Đã có project "${body.id}".`);
      const engine = workspace.create(body.id, { name: body.name, width: body.width, height: body.height });
      return sendJson(res, 201, { id: body.id, ...projectState(engine) });
    }
  }

  const projectId = parts[1]!;
  const engine = engineOf(workspace, projectId);
  const action = parts[2];

  if (action === undefined && method === "GET") return sendJson(res, 200, projectState(engine));

  // Light enough to poll. Only the revision and the running jobs change often.
  if (action === "status" && method === "GET") {
    return sendJson(res, 200, { revision: engine.project.revision, jobs: workspace.jobs.listForProject(projectId) });
  }

  if (method === "POST") {
    switch (action) {
      case "batch": {
        const body = Batch.parse(await readBody());
        const result = engine.applyBatch({
          actor: ACTOR,
          baseRevision: body.baseRevision,
          label: body.label,
          commands: body.commands as never,
        });
        return sendJson(res, 200, { createdClipIds: result.createdClipIds, ...projectState(engine) });
      }
      case "undo":
        engine.undo(ACTOR, Revision.parse(await readBody()).baseRevision);
        return sendJson(res, 200, projectState(engine));
      case "redo":
        engine.redo(ACTOR, Revision.parse(await readBody()).baseRevision);
        return sendJson(res, 200, projectState(engine));
      case "import":
        if (parts[3] === "check") {
          const source = workspace.resolveMediaPath(MediaPath.parse(await readBody()).path);
          const info = await probeMedia(source);
          const { fps } = engine.project;
          return sendJson(res, 200, {
            name: basename(source),
            path: source,
            width: info.width,
            height: info.height,
            sourceFps: info.averageFps,
            projectFps: fpsToNumber(fps),
            reasons: normalizationReasons(info, fps),
            warning: normalizationReasons(info, fps).length > 0 ? judderWarning(info, fps) : undefined,
          });
        }
        return sendJson(res, 202, workspace.startImport(projectId, MediaPath.parse(await readBody()).path));
      case "export":
        return sendJson(res, 202, workspace.startExport(projectId, ExportRequest.parse(await readBody()).name));
    }
  }

  if (method === "GET" || method === "HEAD") {
    if (action === "exports" && parts.length === 4) {
      const name = parts[3]!;
      const path = join(workspace.projectRoot(projectId), "exports", name);
      if (name !== basename(name) || !name.toLowerCase().endsWith(".mp4") || !existsSync(path)) {
        throw new ApiError(404, `Không có file xuất "${name}".`);
      }
      return sendFile(req, res, path, { downloadName: name });
    }

    if (action === "assets" && parts.length === 5) {
      const asset = assetOf(engine, parts[3]!);
      const { cache } = projectPaths(workspace.projectRoot(projectId));
      switch (parts[4]) {
        case "proxy":
          return sendFile(req, res, asset.proxyPath);
        case "peaks":
          return sendJson(res, 200, await loadPeaks(cache, asset, engine.project.fps));
        case "thumbnail": {
          const frame = Number(url.searchParams.get("frame") ?? 0);
          if (!Number.isInteger(frame) || frame < 0 || frame >= asset.durationFrames) {
            throw new ApiError(400, `Video "${asset.name}" không có frame ${url.searchParams.get("frame")}.`);
          }
          const directory = join(cache, "thumbnails");
          const path = join(directory, `${asset.id}-${frame}.jpg`);
          if (!existsSync(path)) {
            mkdirSync(directory, { recursive: true });
            writeFileSync(path, await extractFrame(engine.project, { kind: "asset", assetId: asset.id }, frame, THUMBNAIL_EDGE));
          }
          return sendFile(req, res, path, { cacheControl: "private, max-age=86400" });
        }
      }
    }
  }

  throw new ApiError(404, "Không có đường dẫn này.");
}

/** The REST API of the web UI. It changes projects through the same CommandEngine as MCP. */
export async function handleApi(
  workspace: Workspace,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<void> {
  try {
    await route(workspace, req, res, url, readBody);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
    } else if (error instanceof StaleRevisionError) {
      sendJson(res, 409, { code: "stale_revision", error: error.message });
    } else if (error instanceof ApiError) {
      sendJson(res, error.status, { error: error.message });
    } else if (error instanceof CommandError) {
      sendJson(res, 422, { error: error.message });
    } else if (error instanceof ZodError) {
      const issue = error.issues[0];
      sendJson(res, 400, { error: `Dữ liệu gửi lên không hợp lệ ở "${issue?.path.join(".")}": ${issue?.message}.` });
    } else {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Yêu cầu không xử lý được." });
    }
  }
}
