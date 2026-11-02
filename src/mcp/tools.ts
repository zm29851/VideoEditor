import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { trackEnvelopes } from "../animation.ts";
import { AnimatedProperty, isMediaClip, TextStyle, TrackKind, Transition, type Actor, type Command, type CommandInput, type FrameRate, type Project } from "../schema.ts";
import { timelineDuration } from "../media/export.ts";
import { extractFilmstrip, extractFrame, type FrameSource } from "../media/frames.ts";
import { assetLoudness, clipsLoudness, detectSilence, timelineLoudness } from "../media/analyze.ts";
import { framesToSeconds, frameToTimecode, parseFps, secondsToFrame } from "../time.ts";
import { sourceRangesOnTimeline, speechGaps, subtitleCues, timelineTranscript, type FrameRange, type TimelineSegment } from "../transcript.ts";
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

To edit by what is said: transcribe_asset (a slow job, roughly 0.7 times the video's length with the large model), then get_transcript. Its frames are timeline frames. detect_silence, detect_scenes and get_loudness measure the rest.

To remove pauses and filler words: call detect_silence and get_transcript at the same revision, choose the ranges (use speechGaps from detect_silence when noise hides the pauses), then send them all in one delete_ranges, which reads every range against the timeline before it runs and closes the gaps. Whisper timings can be off by a few tenths of a second and it often leaves out sounds like "ờ", so listen with render_preview before exporting. The filler flag is only a hint: read the sentence, since "à" can be a real word. Whisper also invents lines over noise, such as requests to subscribe: check odd lines with get_frame or by listening before relying on them.

Every edit needs baseRevision, the revision from your last read. If it is rejected as stale, the timeline has changed: call get_timeline and decide again. Do not blindly retry. Originals are never modified, and undo reverts a whole batch.

In apply_batch, a later command can act on a clip made earlier in the batch: give add_clip or split_clip an "as" name, then pass that name as clipId. The response lists the real ids under aliases. Never guess a new clip's id.

Layers: later tracks draw over earlier ones. add_track makes video (overlays, cutaways), audio (music) and text tracks; pass your own id to use the track later in the same batch. Speech is read from the first video track only. A ripple only moves clips on the tracks it names: to keep subtitles in step, pass the text tracks to delete_ranges as alsoTrackIds, and leave music out.

Text: add_text, or generate_subtitles to fill a text track from the transcript. Check the look with get_frame.

Look: set_transform moves, sizes and fades a clip, and fit chooses contain or cover. x and y are shares of the canvas measured from its centre, scale 1 is the fitted size. set_keyframes animates x, y, scale, opacity or volume, with frames counted from the clip's first frame. set_transition goes on the later clip of a cut and does not change the timeline's length: crossfade plays the earlier clip on past its end, so it needs unused source there and shortens to what is left, falling back to a fade-in with none; dip fades out and in with the cut in the middle. get_timeline shows what applies under transitionApplied. set_canvas changes the frame size, for example 1080x1920 for vertical, and can be undone.

cancel_job stops a job that is waiting or running and removes its partial files.`;

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
    ripple: z.boolean().default(false).describe("Growing into a neighbour pushes the later clips back, just far enough, instead of failing."),
    alsoTrackIds: z.array(z.string()).default([]).describe("With ripple: other tracks pushed by the same amount, such as the subtitles. Leave music out."),
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
  delete_ranges: {
    trackId: z.string().default("video_1"),
    alsoTrackIds: z.array(z.string()).default([]).describe("Other tracks to cut the same way, such as the subtitles. Leave music out."),
    ranges: z
      .array(z.object({ start: Time, end: Time.describe("Exclusive.") }))
      .min(1)
      .describe("Timeline positions, all as they are before this edit. Do not adjust for earlier ranges."),
    ripple: z.boolean().default(true).describe("Close the gaps by moving what follows earlier."),
  },
  add_text: {
    trackId: z.string().describe("A text track, from add_track."),
    start: Time,
    duration: Time,
    text: z.string(),
    style: TextStyle.partial().optional().describe("fontSize is a percentage of the canvas height, default 5. Colours are #rrggbb. background is a box, null for an outline."),
    y: z.number().min(-2).max(2).default(0.38).describe("Up or down from the centre as a share of the canvas height. 0.38 sits near the bottom."),
  },
  set_text: {
    clipId: z.string(),
    text: z.string().optional(),
    style: TextStyle.partial().optional(),
  },
  add_track: {
    kind: TrackKind,
    id: z.string().optional().describe("Letters, digits, _ and -. Lets later commands in this batch use the track."),
  },
  remove_track: {
    trackId: z.string().describe("Its clips go with it. Undo brings them back."),
  },
  set_transform: {
    clipId: z.string(),
    x: z.number().min(-2).max(2).optional().describe("Right of centre as a share of the canvas width."),
    y: z.number().min(-2).max(2).optional().describe("Below centre as a share of the canvas height."),
    scale: z.number().min(0.01).max(10).optional(),
    opacity: z.number().min(0).max(1).optional(),
    fit: z.enum(["contain", "cover"]).optional().describe("contain shows the whole picture, cover fills the canvas and crops the rest."),
  },
  set_keyframes: {
    clipId: z.string(),
    property: AnimatedProperty,
    keyframes: z.array(z.object({ at: Time.describe("Counted from the clip's first frame."), value: z.number() })).describe("Replaces what the property had. Empty goes back to the fixed value."),
  },
  set_transition: {
    clipId: z.string().describe("The later clip of the cut."),
    transition: z.object({ type: Transition.shape.type, duration: Time }).nullable().describe("null removes it."),
  },
  set_canvas: {
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(7680),
  },
};

const ClipAlias = z.string().min(1).max(64).optional().describe("A name for the new clip. Later commands in this batch can pass it as clipId.");

const BatchOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_clip"), as: ClipAlias, ...ClipOp.add_clip }),
  z.object({
    type: z.literal("split_clip"),
    as: ClipAlias.describe("A name for the second clip. Later commands in this batch can pass it as clipId."),
    ...ClipOp.split_clip,
  }),
  z.object({ type: z.literal("trim_clip"), ...ClipOp.trim_clip }),
  z.object({ type: z.literal("move_clip"), ...ClipOp.move_clip }),
  z.object({ type: z.literal("delete_clip"), ...ClipOp.delete_clip }),
  z.object({ type: z.literal("set_volume"), ...ClipOp.set_volume }),
  z.object({ type: z.literal("delete_ranges"), ...ClipOp.delete_ranges }),
  z.object({ type: z.literal("add_text"), as: ClipAlias, ...ClipOp.add_text }),
  z.object({ type: z.literal("set_text"), ...ClipOp.set_text }),
  z.object({ type: z.literal("add_track"), ...ClipOp.add_track }),
  z.object({ type: z.literal("remove_track"), ...ClipOp.remove_track }),
  z.object({ type: z.literal("set_transform"), ...ClipOp.set_transform }),
  z.object({ type: z.literal("set_keyframes"), ...ClipOp.set_keyframes }),
  z.object({ type: z.literal("set_transition"), ...ClipOp.set_transition }),
  z.object({ type: z.literal("set_canvas"), ...ClipOp.set_canvas }),
]);
type BatchOp = z.infer<typeof BatchOp>;

function toCommand(op: BatchOp, fps: FrameRate): CommandInput {
  switch (op.type) {
    case "add_text": {
      const { y, ...rest } = op;
      return { ...rest, style: op.style ?? {}, transform: { y }, start: toFrame(op.start, fps), duration: toFrame(op.duration, fps) };
    }
    case "set_keyframes":
      return { ...op, keyframes: op.keyframes.map((key) => ({ frame: toFrame(key.at, fps), value: key.value })) };
    case "set_transition":
      return { ...op, transition: op.transition && { type: op.transition.type, duration: toFrame(op.transition.duration, fps) } };
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
    case "delete_ranges":
      return { ...op, ranges: op.ranges.map((range) => ({ start: toFrame(range.start, fps), end: toFrame(range.end, fps) })) };
    default:
      return op satisfies CommandInput;
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
      hasVideo: asset.hasVideo,
      hasAudio: asset.hasAudio,
    })),
    tracks: project.timeline.tracks.map((track) => {
      const envelopes = trackEnvelopes(track.clips, project.assets);
      return {
        id: track.id,
        kind: track.kind,
        clips: track.clips.map((clip) => {
          const envelope = envelopes.get(clip.id)!;
          return {
            ...clip,
            end: clip.start + clip.duration,
            startTimecode: frameToTimecode(clip.start, fps),
            endTimecode: frameToTimecode(clip.start + clip.duration, fps),
            ...(clip.transitionIn
              ? { transitionApplied: envelope.tail ? `crossfade over ${envelope.tail.frames} frames` : clip.transitionIn.type === "dip" ? `dip, fading in over ${envelope.fadeIn} frames` : `fade-in over ${envelope.fadeIn} frames, nothing to dissolve from` }
              : {}),
          };
        }),
      };
    }),
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
        "Create a project. Its fps is fixed once created, so match the footage: every video imported later is converted to it. Choose the size for the final video: 1920x1080 for landscape, 1080x1920 for portrait, 1080x1080 for square, 1080x1350 for 4:5. It can be changed later with set_canvas.",
      inputSchema: {
        projectId: z.string().describe('Letters, digits, "_" and "-" only.'),
        width: z.number().int().positive().default(1920),
        height: z.number().int().positive().default(1080),
        fps: z.string().default("30").describe('Such as "24", "25", "30", "60", "29.97" or "30000/1001".'),
        folder: z.string().optional().describe("Absolute path of an existing folder to keep this project in, when the person chose one. Everything the project makes goes there. Leave it out for the default place."),
      },
    },
    guarded(({ projectId, width, height, fps, folder }) => {
      const engine = workspace.create(projectId, { width, height, fps: parseFps(fps), ...(folder ? { folder } : {}) });
      return json({ ...describeProject(engine.project), folder: workspace.projectRoot(projectId) });
    }),
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
      description: "Recent edits, newest first, and who made each one. revertsRevision marks an edit that took back one earlier batch, often yours: do not redo it without asking.",
      inputSchema: { projectId: ProjectId, limit: z.number().int().min(1).max(200).default(20) },
    },
    guarded(({ projectId, limit }) =>
      json(
        workspace
          .engine(projectId)
          .history.slice(-limit)
          .reverse()
          .map(({ revision, kind, actor, label, commands, revertsRevision, at }) => ({ revision, kind, actor, label, commands, revertsRevision, at })),
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
        "Import a video or a sound file, such as music, by absolute path from an allowed folder. Runs as a job: conversion and the proxy can take a while. The asset appears in the project when the job succeeds, which also raises the revision.",
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
    "delete_ranges",
    {
      description:
        "Remove several parts of the timeline as one undo step, cutting clips where needed. For pauses and unwanted words from detect_silence and get_transcript.",
      inputSchema: {
        projectId: ProjectId,
        baseRevision: BaseRevision,
        label: z.string().describe("What this edit does, in words the human editor will read in the history."),
        ...ClipOp.delete_ranges,
      },
    },
    guarded(({ projectId, baseRevision, label, ...op }) => applyOps(projectId, baseRevision, label, [{ type: "delete_ranges", ...op }])),
  );

  const singleEdits: Array<[keyof typeof ClipOp & BatchOp["type"], string, string]> = [
    ["add_text", "Thêm chữ", "Put text on a text track. For subtitles from speech, use generate_subtitles."],
    ["set_text", "Sửa chữ", "Change the words or the look of a text clip."],
    ["add_track", "Thêm track", "Add a video, audio or text track. Later tracks draw over earlier ones."],
    ["remove_track", "Xóa track", "Remove a track and its clips. The last video track cannot go."],
    ["set_transform", "Đổi vị trí và kích thước", "Move, resize or fade a clip, or choose how it fits the canvas."],
    ["set_keyframes", "Đặt keyframe", "Animate x, y, scale, opacity or volume across a clip, in straight lines between keyframes."],
    ["set_transition", "Đặt transition", "Set how a clip takes over from the one before it. It does not change the timeline's length."],
    ["set_canvas", "Đổi khung hình", "Change the frame size of the video. Width and height must be even."],
  ];
  for (const [type, label, description] of singleEdits) {
    server.registerTool(
      type,
      { description, inputSchema: { projectId: ProjectId, baseRevision: BaseRevision, ...ClipOp[type] } },
      guarded(({ projectId, baseRevision, ...op }: { projectId: string; baseRevision: number } & Record<string, unknown>) =>
        applyOps(projectId, baseRevision, label, [{ type, ...op } as BatchOp]),
      ) as never,
    );
  }

  server.registerTool(
    "generate_subtitles",
    {
      description:
        "Fill a text track with subtitles from the transcript of the first video track, as one undo step. Transcribe first. Whisper timings can be off, so check with render_preview. Later cuts need alsoTrackIds to keep them in step.",
      inputSchema: {
        projectId: ProjectId,
        baseRevision: BaseRevision,
        trackId: z.string().optional().describe("An empty stretch of this text track is needed. Leave out to make a new track."),
        maxChars: z.number().int().min(10).max(120).default(42).describe("Longest line before starting a new subtitle."),
        style: TextStyle.partial().optional(),
      },
    },
    guarded(({ projectId, baseRevision, trackId, maxChars, style }) => {
      const project = workspace.engine(projectId).project;
      const cues = subtitleCues(timelineTranscript(project, workspace.transcripts(projectId)), maxChars);
      if (cues.length === 0) throw new Error("Chưa có lời nói nào để tạo phụ đề. Hãy chạy transcribe_asset rồi thử lại.");
      const target = trackId ?? `text_subtitles_${project.revision}`;
      const ops: CommandInput[] = [
        ...(trackId ? [] : [{ type: "add_track" as const, kind: "text" as const, id: target }]),
        ...cues.map((cue) => ({ type: "add_text" as const, trackId: target, start: cue.start, duration: cue.end - cue.start, text: cue.text, style: style ?? {} })),
      ];
      const engine = workspace.engine(projectId);
      const result = engine.applyBatch({ actor: ACTOR, baseRevision, label: `Tạo ${cues.length} phụ đề`, commands: ops });
      return json({ revision: result.revision, trackId: target, count: cues.length, clipIds: result.createdClipIds });
    }),
  );

  server.registerTool(
    "transcribe_asset",
    {
      description:
        "Turn a video's speech into text with word timings. Runs as a slow job and is kept with the project, so each video needs it once. Set force to redo it, for example in another language.",
      inputSchema: {
        projectId: ProjectId,
        assetId: z.string(),
        language: z.string().default("vi").describe('A code such as "vi" or "en", or "auto" to detect it.'),
        force: z.boolean().default(false),
      },
    },
    guarded(({ projectId, assetId, language, force }) => {
      if (!force && workspace.transcript(projectId, assetId)) {
        return json({ alreadyTranscribed: true, assetId, next: "Call get_transcript, or set force to redo it." });
      }
      return json(workspace.startTranscribe(projectId, assetId, language));
    }),
  );

  server.registerTool(
    "get_transcript",
    {
      description:
        "Read what is said on the timeline, in timeline frames and following the current cuts. Lists possible filler words, and the videos with no transcript yet. Long results: set includeWords only with a start and end.",
      inputSchema: {
        projectId: ProjectId,
        start: Time.optional(),
        end: Time.optional().describe("Exclusive."),
        includeWords: z.boolean().default(false).describe("Add every word's frames as [text, start, end]."),
      },
    },
    guarded(({ projectId, start, end, includeWords }) => {
      const project = workspace.engine(projectId).project;
      const { fps } = project;
      const transcripts = workspace.transcripts(projectId);
      const from = start ? toFrame(start, fps) : 0;
      const to = end ? toFrame(end, fps) : Infinity;
      const segments = timelineTranscript(project, transcripts).filter((segment: TimelineSegment) => segment.end > from && segment.start < to);
      const used = new Set(project.timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips.filter(isMediaClip).map((clip) => clip.assetId)));
      return json({
        revision: project.revision,
        segments: segments.map(({ clipId, start: first, end: last, text, words }) => ({
          clipId,
          start: first,
          end: last,
          startTimecode: frameToTimecode(first, fps),
          text,
          ...(includeWords ? { words: words.map((word) => [word.text, word.start, word.end]) } : {}),
        })),
        possibleFillers: segments.flatMap((segment) =>
          segment.words.filter((word) => word.filler).map((word) => ({ text: word.text, start: word.start, end: word.end, clipId: segment.clipId })),
        ),
        assetsWithoutTranscript: project.assets
          .filter((asset) => used.has(asset.id) && asset.hasAudio && !transcripts.has(asset.id))
          .map((asset) => ({ id: asset.id, name: asset.name })),
      });
    }),
  );

  server.registerTool(
    "detect_silence",
    {
      description:
        "Find quiet parts of the timeline, ready for delete_ranges. If it finds nothing in a noisy place, raise noiseDb, for example to -30, or use speechGaps: stretches with no words according to the transcript, which background noise cannot hide. A gap can still hold sound worth keeping, so look or listen before cutting it.",
      inputSchema: {
        projectId: ProjectId,
        noiseDb: z.number().min(-90).max(0).default(-35).describe("Anything quieter than this counts as silence."),
        minSeconds: z.number().min(0.05).default(0.5).describe("Ignore shorter pauses."),
        paddingSeconds: z.number().min(0).default(0.1).describe("Sound kept at each end of a pause, so words are not clipped."),
      },
    },
    guarded(async ({ projectId, noiseDb, minSeconds, paddingSeconds }) => {
      const project = workspace.engine(projectId).project;
      const { fps } = project;
      const onMain = project.timeline.tracks.find((track) => track.kind === "video")?.clips.filter(isMediaClip) ?? [];
      const used = project.assets.filter((asset) => onMain.some((clip) => clip.assetId === asset.id));
      const bySource = new Map<string, FrameRange[]>();
      for (const asset of used) bySource.set(asset.id, await detectSilence(asset, fps, noiseDb, minSeconds));
      const padding = secondsToFrame(paddingSeconds, fps);
      const minFrames = secondsToFrame(minSeconds, fps);
      const ranges = sourceRangesOnTimeline(project, bySource)
        .filter((range) => range.end - range.start >= minFrames)
        .map((range) => ({ ...range, start: range.start + padding, end: range.end - padding }))
        .filter((range) => range.end > range.start);
      const total = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
      const transcripts = workspace.transcripts(projectId);
      const gaps = used.some((asset) => transcripts.has(asset.id))
        ? speechGaps(project, timelineTranscript(project, transcripts), minFrames, padding)
        : undefined;
      return json({
        revision: project.revision,
        ranges: ranges.map((range) => ({
          start: { frame: range.start },
          end: { frame: range.end },
          startTimecode: frameToTimecode(range.start, fps),
          seconds: Math.round(framesToSeconds(range.end - range.start, fps) * 100) / 100,
          clipIds: range.clipIds,
        })),
        totalFrames: total,
        totalSeconds: Math.round(framesToSeconds(total, fps) * 100) / 100,
        assetsWithoutAudio: used.filter((asset) => !asset.hasAudio).map((asset) => asset.id),
        ...(gaps
          ? {
              speechGaps: gaps.map((range) => ({
                start: { frame: range.start },
                end: { frame: range.end },
                startTimecode: frameToTimecode(range.start, fps),
                seconds: Math.round(framesToSeconds(range.end - range.start, fps) * 100) / 100,
              })),
            }
          : { speechGapsNote: "Transcribe the video to also get the stretches with no words." }),
      });
    }),
  );

  server.registerTool(
    "detect_scenes",
    {
      description: "Find where the picture changes abruptly inside the clips on the timeline. Runs as a job. The job result lists the cuts in timeline frames.",
      inputSchema: {
        projectId: ProjectId,
        threshold: z.number().min(0.01).max(1).default(0.3).describe("Lower finds more, including false ones."),
      },
    },
    guarded(({ projectId, threshold }) => json(workspace.startDetectScenes(projectId, threshold))),
  );

  server.registerTool(
    "get_loudness",
    {
      description:
        "Measure loudness to EBU R128. Choose a clip, or a source video with assetId, or leave both out for the whole timeline as it would be exported, at each clip's volume. Web videos usually aim for about -14 to -16 LUFS. null means too quiet to measure.",
      inputSchema: { projectId: ProjectId, clipId: z.string().optional(), assetId: z.string().optional() },
    },
    guarded(async ({ projectId, clipId, assetId }) => {
      const project = workspace.engine(projectId).project;
      const clips = project.timeline.tracks.flatMap((track) => track.clips).filter(isMediaClip);
      if (assetId) {
        const asset = project.assets.find((candidate) => candidate.id === assetId);
        if (!asset) throw new Error(`Không có asset "${assetId}".`);
        if (!asset.hasAudio) throw new Error(`Video "${asset.name}" không có tiếng.`);
        return json(await assetLoudness(asset));
      }
      if (clipId) {
        const clip = clips.find((candidate) => candidate.id === clipId);
        if (!clip) throw new Error(`Không có clip "${clipId}".`);
        return json(await clipsLoudness(project, [clip]));
      }
      return json(await timelineLoudness(project));
    }),
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
    "cancel_job",
    {
      description: "Stop a job that is waiting or running. Its partial files are removed.",
      inputSchema: { jobId: z.string() },
    },
    guarded(({ jobId }) => json(workspace.jobs.cancel(jobId))),
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
      if (!job) throw new Error(`Không có job "${jobId}".`);
      return json(job);
    }),
  );

  return server;
}
