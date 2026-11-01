import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { z, ZodError } from "zod";
import { FrameRate, isMediaClip } from "../schema.ts";
import { CommandError } from "../commands.ts";
import { StaleRevisionError, type CommandEngine } from "../engine.ts";
import { timelineDuration } from "../media/export.ts";
import { extractFrame } from "../media/frames.ts";
import { judderWarning, normalizationReasons } from "../media/import.ts";
import { loadPeaks } from "../media/peaks.ts";
import { probeAudio, probeMedia } from "../media/probe.ts";
import { textImagePath } from "../media/text.ts";
import { projectPaths } from "../store.ts";
import { fpsToNumber } from "../time.ts";
import { isAudioFile, type Workspace } from "../mcp/workspace.ts";
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
export function projectState(engine: CommandEngine): object {
  return { project: engine.project, undoLabel: engine.undoLabel, redoLabel: engine.redoLabel, activity: engine.activity() };
}

const CreateProject = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(100),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(7680),
  fps: FrameRate.refine((fps) => fps.num / fps.den >= 1 && fps.num / fps.den <= 120, "fps phải từ 1 đến 120").optional(),
});
const Batch = z.object({
  baseRevision: z.number().int().nonnegative(),
  label: z.string().min(1).max(200),
  commands: z.array(z.unknown()),
});
const Revision = z.object({ baseRevision: z.number().int().nonnegative() });
const Revert = z.object({ baseRevision: z.number().int().nonnegative(), revision: z.number().int().positive() });
const MediaPath = z.object({ path: z.string().min(1) });
const ExportRequest = z.object({ name: z.string() });
const TranscribeRequest = z.object({ language: z.string() });

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
      const engine = workspace.create(body.id, { name: body.name, width: body.width, height: body.height, ...(body.fps ? { fps: body.fps } : {}) });
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
      case "revert": {
        const body = Revert.parse(await readBody());
        engine.revert(ACTOR, body.baseRevision, body.revision);
        return sendJson(res, 200, projectState(engine));
      }
      case "import":
        if (parts[3] === "check") {
          const source = workspace.resolveMediaPath(MediaPath.parse(await readBody()).path);
          const { fps } = engine.project;
          if (isAudioFile(source)) {
            await probeAudio(source);
            return sendJson(res, 200, { name: basename(source), path: source, width: 0, height: 0, sourceFps: fpsToNumber(fps), projectFps: fpsToNumber(fps), reasons: [] });
          }
          const info = await probeMedia(source);
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
      case "jobs":
        if (parts.length === 5 && workspace.jobs.get(parts[3]!)?.projectId === projectId) {
          if (parts[4] === "cancel") return sendJson(res, 200, workspace.jobs.cancel(parts[3]!));
          if (parts[4] === "dismiss") {
            workspace.jobs.dismiss(parts[3]!);
            return sendJson(res, 200, {});
          }
        }
        break;
      case "assets":
        if (parts.length === 5 && parts[4] === "transcribe") {
          const asset = assetOf(engine, parts[3]!);
          return sendJson(res, 202, workspace.startTranscribe(projectId, asset.id, TranscribeRequest.parse(await readBody()).language));
        }
        break;
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

    // The picture of a text clip, the same one the export draws. Stored by content, so it can be cached.
    if (action === "clips" && parts.length === 5 && parts[4] === "text-image") {
      const { project } = engine;
      const clip = project.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === parts[3]);
      if (!clip || isMediaClip(clip)) throw new ApiError(404, `Không có clip chữ "${parts[3]}".`);
      const { cache } = projectPaths(workspace.projectRoot(projectId));
      return sendFile(req, res, textImagePath(join(cache, "text"), clip, project.width, project.height), { cacheControl: "private, max-age=86400" });
    }

    if (action === "assets" && parts.length === 5) {
      const asset = assetOf(engine, parts[3]!);
      const { cache } = projectPaths(workspace.projectRoot(projectId));
      switch (parts[4]) {
        case "proxy":
          return sendFile(req, res, asset.proxyPath);
        case "peaks":
          return sendJson(res, 200, await loadPeaks(cache, asset, engine.project.fps));
        case "transcript":
          return sendJson(res, 200, { transcript: workspace.transcript(projectId, asset.id) ?? null });
        case "thumbnail": {
          if (!asset.hasVideo) throw new ApiError(404, `"${asset.name}" chỉ có tiếng, không có hình.`);
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
