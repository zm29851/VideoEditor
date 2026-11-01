import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor, Command, CommandInput, FrameRate, Project } from "../schema.ts";
import { timelineDuration } from "../media/export.ts";
import { extractFilmstrip, extractFrame, type FrameSource } from "../media/frames.ts";
import { frameToTimecode, secondsToFrame } from "../time.ts";
import type { Workspace } from "./workspace.ts";

const ACTOR: Actor = "agent";
const MAX_WAIT_SECONDS = 50;

const INSTRUCTIONS = `Video editor for one project timeline, shared live with a human editor.

Every position is a whole frame at the project's fps. Time arguments take either {"frame": 300} or {"seconds": 10.0}; seconds snap to the nearest frame and the response shows the frame used.

Workflow:
1. create_project or list_projects, then import_asset and wait for its job with get_job_status.
2. Look before cutting: get_filmstrip and get_frame show the source (assetId) or the timeline.
3. Edit with add_clip, split_clip, trim_clip, move_clip, delete_clip, set_volume, or several at once with apply_batch.
4. Check with get_filmstrip on the timeline or render_preview, then export_video.

Every edit needs baseRevision, the revision from your last read. If it is rejected as stale, the timeline has changed: call get_timeline and decide again. Do not blindly retry. Originals are never modified, and undo reverts a whole batch.`;

const Time = z.union([
  z.object({ frame: z.number().int() }).strict(),
  z.object({ seconds: z.number() }).strict(),
]);
type Time = z.infer<typeof Time>;

function toFrame(time: Time, fps: FrameRate): number {
  return "frame" in time ? time.frame : secondsToFrame(time.seconds, fps);
}

const ClipOp = {
  add_clip: {
    trackId: z.string().default("video_1"),
    assetId: z.string(),
    start: Time.describe("Timeline position."),
    sourceIn: Time.default({ frame: 0 }).describe("First frame used from the asset."),
    duration: Time,
    volume: z.number().min(0).max(200).default(100),
  },
  split_clip: {
    clipId: z.string(),
    at: Time.describe("Timeline position that becomes the first frame of the second clip."),
  },
  trim_clip: {
    clipId: z.string(),
    edge: z.enum(["start", "end"]),
    delta: Time.describe("Positive moves the edge later, negative moves it earlier."),
  },
  move_clip: {
    clipId: z.string(),
    start: Time,
    trackId: z.string().optional(),
  },
  delete_clip: {
    clipId: z.string(),
    ripple: z.boolean().default(false).describe("Close the gap by moving later clips earlier."),
  },
  set_volume: {
    clipId: z.string(),
    volume: z.number().min(0).max(200).describe("100 is the original level."),
  },
};

const BatchOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_clip"), ...ClipOp.add_clip }),
  z.object({ type: z.literal("split_clip"), ...ClipOp.split_clip }),
  z.object({ type: z.literal("trim_clip"), ...ClipOp.trim_clip }),
  z.object({ type: z.literal("move_clip"), ...ClipOp.move_clip }),
  z.object({ type: z.literal("delete_clip"), ...ClipOp.delete_clip }),
  z.object({ type: z.literal("set_volume"), ...ClipOp.set_volume }),
]);
type BatchOp = z.infer<typeof BatchOp>;

function toCommand(op: BatchOp, fps: FrameRate): CommandInput {
  switch (op.type) {
    case "add_clip":
      return {
        ...op,
        start: toFrame(op.start, fps),
        sourceIn: toFrame(op.sourceIn, fps),
        duration: toFrame(op.duration, fps),
      };
    case "split_clip":
      return { ...op, at: toFrame(op.at, fps) };
    case "trim_clip":
      return { ...op, delta: toFrame(op.delta, fps) };
    case "move_clip":
      return { ...op, start: toFrame(op.start, fps) };
    default:
      return op satisfies Command;
  }
}

function describeProject(project: Project): object {
  const duration = timelineDuration(project);
  const { fps } = project;
  return {
    name: project.name,
    revision: project.revision,
    fps: `${fps.num}/${fps.den}`,
    size: `${project.width}x${project.height}`,
    durationFrames: duration,
    durationTimecode: frameToTimecode(duration, fps),
    assets: project.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      durationFrames: asset.durationFrames,
      durationTimecode: frameToTimecode(asset.durationFrames, fps),
      size: `${asset.width}x${asset.height}`,
      hasAudio: asset.hasAudio,
    })),
    tracks: project.timeline.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      clips: track.clips.map((clip) => ({
        ...clip,
        end: clip.start + clip.duration,
        startTimecode: frameToTimecode(clip.start, fps),
        endTimecode: frameToTimecode(clip.start + clip.duration, fps),
      })),
    })),
  };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

/** Failures reach the agent as a readable result it can act on, not a protocol error. */
function guarded<A>(handler: (args: A) => Promise<ToolResult> | ToolResult) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

const ProjectId = z.string().describe("Project name from list_projects or create_project.");
const BaseRevision = z.number().int().nonnegative().describe("Revision from your last read of the timeline.");

export function createMcpServer(workspace: Workspace): McpServer {
  const server = new McpServer({ name: "video-editor", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const applyOps = (projectId: string, baseRevision: number, label: string, ops: BatchOp[]) => {
    const engine = workspace.engine(projectId);
    const { fps } = engine.project;
    const result = engine.applyBatch({
      actor: ACTOR,
      baseRevision,
      label,
      commands: ops.map((op) => toCommand(op, fps)),
    });
    const project = engine.project;
    return json({
      ...result,
      durationFrames: timelineDuration(project),
      durationTimecode: frameToTimecode(timelineDuration(project), fps),
      clips: project.timeline.tracks.flatMap((track) => track.clips),
    });
  };

  server.registerTool(
    "list_projects",
    { description: "List the projects in this workspace.", inputSchema: {} },
    guarded(() => json({ projects: workspace.list(), allowedMediaFolders: workspace.mediaDirs })),
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project. Its fps is fixed at 30. Choose the size for the final video: 1920x1080 for landscape, 1080x1920 for portrait.",
      inputSchema: {
        projectId: z.string().describe('Letters, digits, "_" and "-" only.'),
        width: z.number().int().positive().default(1920),
        height: z.number().int().positive().default(1080),
      },
    },
    guarded(({ projectId, width, height }) => json(describeProject(workspace.create(projectId, { width, height }).project))),
  );

  server.registerTool(
    "get_timeline",
    { description: "Read the project: revision, assets and every clip.", inputSchema: { projectId: ProjectId } },
    guarded(({ projectId }) => json(describeProject(workspace.engine(projectId).project))),
  );

  server.registerTool(
    "get_asset_info",
    {
      description: "Details of one imported video, including what import had to convert.",
      inputSchema: { projectId: ProjectId, assetId: z.string() },
    },
    guarded(({ projectId, assetId }) => {
      const asset = workspace.engine(projectId).project.assets.find((candidate) => candidate.id === assetId);
      if (!asset) throw new Error(`Không có asset "${assetId}".`);
      return json(asset);
    }),
  );

  server.registerTool(
    "get_history",
    {
      description: "Recent edits, newest first, and who made each one.",
      inputSchema: { projectId: ProjectId, limit: z.number().int().min(1).max(200).default(20) },
    },
    guarded(({ projectId, limit }) =>
      json(
        workspace
          .engine(projectId)
          .history.slice(-limit)
          .reverse()
          .map(({ revision, kind, actor, label, commands, at }) => ({ revision, kind, actor, label, commands, at })),
      ),
    ),
  );

  const frameSource = (assetId: string | undefined): FrameSource =>
    assetId ? { kind: "asset", assetId } : { kind: "timeline" };
  const SourceAsset = z.string().optional().describe("Read this source video. Leave out to read the edited timeline.");

  server.registerTool(
    "get_frame",
    {
      description: "See one frame as an image, from the timeline or from a source asset.",
      inputSchema: {
        projectId: ProjectId,
        at: Time,
        assetId: SourceAsset,
        maxEdge: z.number().int().min(64).max(1280).default(960),
      },
    },
    guarded(async ({ projectId, at, assetId, maxEdge }) => {
      const project = workspace.engine(projectId).project;
      const frame = toFrame(at, project.fps);
      if (frame < 0) throw new Error("Vị trí frame không được âm.");
      const image = await extractFrame(project, frameSource(assetId), frame, maxEdge);
      return {
        content: [
          { type: "text", text: JSON.stringify({ frame, timecode: frameToTimecode(frame, project.fps) }) },
          { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    }),
  );

  server.registerTool(
    "get_filmstrip",
    {
      description:
        "See evenly spaced frames from a range as one grid image, read left to right, top to bottom. The response lists the frame number of each tile.",
      inputSchema: {
        projectId: ProjectId,
        start: Time,
        end: Time.describe("Exclusive."),
        assetId: SourceAsset,
        count: z.number().int().min(1).max(24).default(12),
      },
    },
    guarded(async ({ projectId, start, end, assetId, count }) => {
      const project = workspace.engine(projectId).project;
      const from = toFrame(start, project.fps);
      const to = toFrame(end, project.fps);
      if (from < 0 || to <= from) throw new Error(`Khoảng frame ${from}..${to} không hợp lệ.`);
      const strip = await extractFilmstrip(project, frameSource(assetId), from, to, count, 320);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              columns: strip.columns,
              rows: strip.rows,
              tiles: strip.frames.map((frame) => ({ frame, timecode: frameToTimecode(frame, project.fps) })),
            }),
          },
          { type: "image", data: strip.image.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    }),
  );

  server.registerTool(
    "import_asset",
    {
      description:
        "Import a video by absolute path from an allowed folder. Runs as a job: conversion and the proxy can take a while. The asset appears in the project when the job succeeds, which also raises the revision.",
      inputSchema: { projectId: ProjectId, path: z.string() },
    },
    guarded(({ projectId, path }) => json(workspace.startImport(projectId, path))),
  );

  server.registerTool(
    "add_clip",
    {
      description: "Place part of an asset on the timeline. Clips on a track cannot overlap.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp.add_clip },
    },
    guarded(({ projectId, baseRevision, ...op }) =>
      applyOps(projectId, baseRevision, "Thêm clip", [{ type: "add_clip", ...op }]),
    ),
  );

  server.registerTool(
    "split_clip",
    {
      description: "Cut one clip into two at a timeline position.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp.split_clip },
    },
    guarded(({ projectId, baseRevision, ...op }) =>
      applyOps(projectId, baseRevision, "Cắt clip", [{ type: "split_clip", ...op }]),
    ),
  );

  server.registerTool(
    "trim_clip",
    {
      description: "Move a clip's start or end edge. The other edge stays where it is on the timeline.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp.trim_clip },
    },
    guarded(({ projectId, baseRevision, ...op }) =>
      applyOps(projectId, baseRevision, "Trim clip", [{ type: "trim_clip", ...op }]),
    ),
  );

  server.registerTool(
    "move_clip",
    {
      description: "Move a clip to a new timeline position.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp.move_clip },
    },
    guarded(({ projectId, baseRevision, ...op }) =>
      applyOps(projectId, baseRevision, "Di chuyển clip", [{ type: "move_clip", ...op }]),
    ),
  );

  server.registerTool(
    "delete_clip",
    {
      description: "Remove a clip from the timeline. The source asset stays in the project.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp.delete_clip },
    },
    guarded(({ projectId, baseRevision, ...op }) =>
      applyOps(projectId, baseRevision, "Xóa clip", [{ type: "delete_clip", ...op }]),
    ),
  );

  server.registerTool(
    "set_volume",
    {
      description: "Set the audio level of a clip.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp.set_volume },
    },
    guarded(({ projectId, baseRevision, ...op }) =>
      applyOps(projectId, baseRevision, "Đổi âm lượng", [{ type: "set_volume", ...op }]),
    ),
  );

  server.registerTool(
    "apply_batch",
    {
      description:
        "Run several edits in order as one undo step. All succeed or none do. Prefer this over separate calls, each of which raises the revision.",
      inputSchema: {
        projectId: ProjectId,
        baseRevision: BaseRevision,
        label: z.string().describe("What this edit does, in words the human editor will read in the history."),
        commands: z.array(BatchOp).min(1),
      },
    },
    guarded(({ projectId, baseRevision, label, commands }) => applyOps(projectId, baseRevision, label, commands)),
  );

  server.registerTool(
    "undo",
    {
      description: "Revert the most recent edit or batch, whoever made it.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision },
    },
    guarded(({ projectId, baseRevision }) => json(workspace.engine(projectId).undo(ACTOR, baseRevision))),
  );

  server.registerTool(
    "redo",
    {
      description: "Reapply the most recently undone edit.",
      inputSchema: { projectId: ProjectId, baseRevision: BaseRevision },
    },
    guarded(({ projectId, baseRevision }) => json(workspace.engine(projectId).redo(ACTOR, baseRevision))),
  );

  server.registerTool(
    "render_preview",
    {
      description: "Render part of the timeline to a small, fast video from the proxies. Runs as a job.",
      inputSchema: {
        projectId: ProjectId,
        start: Time.default({ frame: 0 }),
        end: Time.optional().describe("Exclusive. Leave out to go to the end."),
      },
    },
    guarded(({ projectId, start, end }) => {
      const project = workspace.engine(projectId).project;
      const from = toFrame(start, project.fps);
      const to = end ? toFrame(end, project.fps) : timelineDuration(project);
      return json(workspace.startPreview(projectId, from, to));
    }),
  );

  server.registerTool(
    "export_video",
    {
      description:
        "Render the final video from the timeline as it is now, into the project's exports folder. Runs as a job, and later edits do not affect it. The job result gives the file path.",
      inputSchema: {
        projectId: ProjectId,
        name: z
          .string()
          .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,99}$/u)
          .default("export")
          .describe("File name without a folder. .mp4 is added."),
      },
    },
    guarded(({ projectId, name }) => json(workspace.startExport(projectId, name))),
  );

  server.registerTool(
    "get_job_status",
    {
      description: "Check a job. Set waitSeconds to hold the call until it finishes, up to the limit, rather than polling.",
      inputSchema: {
        jobId: z.string(),
        waitSeconds: z.number().min(0).max(MAX_WAIT_SECONDS).default(0),
      },
    },
    guarded(async ({ jobId, waitSeconds }) => {
      const job = await workspace.jobs.wait(jobId, waitSeconds * 1000);
      if (!job) throw new Error(`Không có job "${jobId}". Job không còn sau khi server khởi động lại.`);
      return json(job);
    }),
  );

  return server;
}
