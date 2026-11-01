import { z } from "zod";

const frames = z.number().int().nonnegative();
const positiveFrames = z.number().int().positive();

export const FrameRate = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});
export type FrameRate = z.infer<typeof FrameRate>;

export const Asset = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  originalPath: z.string().min(1),
  /** Frame-exact file at the project's fps. It is the original when no conversion was needed. */
  masterPath: z.string().min(1),
  proxyPath: z.string().min(1),
  /** Number of frames in both master and proxy. */
  durationFrames: positiveFrames,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
  normalization: z.object({
    transcoded: z.boolean(),
    reasons: z.array(z.string()),
    sourceFps: z.number().positive(),
    wasHdr: z.boolean(),
  }),
});
export type Asset = z.infer<typeof Asset>;

export const Clip = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  /** Position on the timeline. */
  start: frames,
  /** First frame used from the asset. */
  sourceIn: frames,
  duration: positiveFrames,
  /** 100 is the original level. */
  volume: z.number().min(0).max(200),
});
export type Clip = z.infer<typeof Clip>;

export const Track = z.object({
  id: z.string().min(1),
  kind: z.literal("video"),
  clips: z.array(Clip),
});
export type Track = z.infer<typeof Track>;

export const Timeline = z.object({
  tracks: z.array(Track),
});
export type Timeline = z.infer<typeof Timeline>;

export const Project = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** Locked when the project is created: every frame number in the project is in this rate. */
  fps: FrameRate,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  nextClipNumber: z.number().int().positive(),
  assets: z.array(Asset),
  timeline: Timeline,
});
export type Project = z.infer<typeof Project>;

export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_clip"),
    trackId: z.string(),
    assetId: z.string(),
    start: frames,
    sourceIn: frames.default(0),
    duration: positiveFrames,
    volume: z.number().min(0).max(200).default(100),
  }),
  z.object({
    type: z.literal("split_clip"),
    clipId: z.string(),
    /** Timeline frame that becomes the first frame of the second clip. */
    at: frames,
  }),
  z.object({
    type: z.literal("trim_clip"),
    clipId: z.string(),
    edge: z.enum(["start", "end"]),
    /** Positive moves the edge later, negative moves it earlier. */
    delta: z.number().int(),
  }),
  z.object({
    type: z.literal("move_clip"),
    clipId: z.string(),
    start: frames,
    trackId: z.string().optional(),
  }),
  z.object({
    type: z.literal("delete_clip"),
    clipId: z.string(),
    /** Close the gap by moving later clips on the track earlier. */
    ripple: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("set_volume"),
    clipId: z.string(),
    volume: z.number().min(0).max(200),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandInput = z.input<typeof Command>;

export const Actor = z.enum(["user", "agent"]);
export type Actor = z.infer<typeof Actor>;

export const HistoryEntry = z.object({
  revision: z.number().int().positive(),
  kind: z.enum(["apply", "undo", "redo"]),
  actor: Actor,
  label: z.string(),
  commands: z.array(Command),
  before: Timeline,
  after: Timeline,
  at: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;
