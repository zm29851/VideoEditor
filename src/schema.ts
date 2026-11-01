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
  /** 0 for a sound file, which has no picture. */
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  hasVideo: z.boolean().default(true),
  hasAudio: z.boolean(),
  normalization: z.object({
    transcoded: z.boolean(),
    reasons: z.array(z.string()),
    sourceFps: z.number().positive(),
    wasHdr: z.boolean(),
  }),
});
export type Asset = z.infer<typeof Asset>;

const Keyframe = z.object({
  /** Frame inside the clip, 0 being its first frame. */
  frame: frames,
  value: z.number(),
});
export type Keyframe = z.infer<typeof Keyframe>;

/** What can change over a clip. Between keyframes values move in a straight line, outside them they hold. */
export const AnimatedProperty = z.enum(["x", "y", "scale", "opacity", "volume"]);
export type AnimatedProperty = z.infer<typeof AnimatedProperty>;

const Keyframes = z.object({
  x: z.array(Keyframe).optional(),
  y: z.array(Keyframe).optional(),
  scale: z.array(Keyframe).optional(),
  opacity: z.array(Keyframe).optional(),
  volume: z.array(Keyframe).optional(),
});
export type Keyframes = z.infer<typeof Keyframes>;

/** x and y move the centre, as a share of the canvas width and height. Scale 1 is the fitted size. */
export const Transform = z.object({
  x: z.number().min(-2).max(2).default(0),
  y: z.number().min(-2).max(2).default(0),
  scale: z.number().min(0.01).max(10).default(1),
  opacity: z.number().min(0).max(1).default(1),
});
export type Transform = z.infer<typeof Transform>;

export const Transition = z.object({
  /** crossfade dissolves from the clip before it, dip goes through transparent with the cut in the middle. */
  type: z.enum(["crossfade", "dip"]),
  duration: positiveFrames,
});
export type Transition = z.infer<typeof Transition>;

const clipEffects = {
  transform: Transform.optional(),
  keyframes: Keyframes.optional(),
  /** How this clip takes over from the one before it. Its length does not change the timeline. */
  transitionIn: Transition.optional(),
};

export const MediaClip = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  /** Position on the timeline. */
  start: frames,
  /** First frame used from the asset. */
  sourceIn: frames,
  duration: positiveFrames,
  /** 100 is the original level. */
  volume: z.number().min(0).max(200),
  /** contain shows the whole picture, cover fills the canvas and crops what is left over. */
  fit: z.enum(["contain", "cover"]).optional(),
  ...clipEffects,
});
export type MediaClip = z.infer<typeof MediaClip>;

export const TextStyle = z.object({
  /** Share of the canvas height, in percent, so the look survives a change of size. */
  fontSize: z.number().min(1).max(30).default(5),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  /** A box behind the text, or null for an outline only. */
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  weight: z.union([z.literal(400), z.literal(600)]).default(600),
});
export type TextStyle = z.infer<typeof TextStyle>;

export const TextClip = z.object({
  id: z.string().min(1),
  kind: z.literal("text"),
  start: frames,
  duration: positiveFrames,
  text: z.string().min(1).max(2000),
  style: TextStyle,
  ...clipEffects,
});
export type TextClip = z.infer<typeof TextClip>;

export const Clip = z.union([MediaClip, TextClip]);
export type Clip = z.infer<typeof Clip>;

export function isMediaClip(clip: Clip): clip is MediaClip {
  return "assetId" in clip;
}

export const TrackKind = z.enum(["video", "audio", "text"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z.object({
  id: z.string().min(1),
  kind: TrackKind,
  /** Later tracks draw over earlier ones. */
  clips: z.array(Clip),
});
export type Track = z.infer<typeof Track>;

export const Canvas = z.object({
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(7680),
});
export type Canvas = z.infer<typeof Canvas>;

export const Timeline = z.object({
  tracks: z.array(Track),
  /** Kept here so undo brings the size back. Older history entries do not have it. */
  canvas: Canvas.optional(),
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

/** A name that later commands of the same batch can use as clipId, because the real id is not known yet. */
const clipAlias = z.string().min(1).max(64).optional();

export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_clip"),
    as: clipAlias,
    trackId: z.string(),
    assetId: z.string(),
    start: frames,
    sourceIn: frames.default(0),
    duration: positiveFrames,
    volume: z.number().min(0).max(200).default(100),
  }),
  z.object({
    type: z.literal("split_clip"),
    /** Names the second clip. The first clip keeps its id. */
    as: clipAlias,
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
  z.object({
    type: z.literal("add_text"),
    as: clipAlias,
    trackId: z.string(),
    start: frames,
    duration: positiveFrames,
    text: z.string().trim().min(1).max(2000),
    style: TextStyle.default({}),
    /** Near the bottom of the canvas, where subtitles belong. */
    transform: Transform.default({ y: 0.38 }),
  }),
  z.object({
    type: z.literal("set_text"),
    clipId: z.string(),
    text: z.string().trim().min(1).max(2000).optional(),
    style: TextStyle.partial().optional(),
  }),
  z.object({
    type: z.literal("add_track"),
    kind: TrackKind,
    /** Lets later commands of the batch use the track. Chosen for you when left out. */
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  }),
  z.object({
    type: z.literal("remove_track"),
    trackId: z.string(),
  }),
  z.object({
    type: z.literal("set_transform"),
    clipId: z.string(),
    x: z.number().min(-2).max(2).optional(),
    y: z.number().min(-2).max(2).optional(),
    scale: z.number().min(0.01).max(10).optional(),
    opacity: z.number().min(0).max(1).optional(),
    fit: z.enum(["contain", "cover"]).optional(),
  }),
  z.object({
    type: z.literal("set_keyframes"),
    clipId: z.string(),
    property: AnimatedProperty,
    /** Replaces what the property had. Empty goes back to the fixed value. */
    keyframes: z.array(Keyframe),
  }),
  z.object({
    type: z.literal("set_transition"),
    clipId: z.string(),
    /** null removes it. */
    transition: Transition.nullable(),
  }),
  z.object({
    type: z.literal("set_canvas"),
    width: Canvas.shape.width,
    height: Canvas.shape.height,
  }),
  z.object({
    type: z.literal("delete_ranges"),
    trackId: z.string(),
    /** Other tracks to cut the same way, so subtitles stay with the speech. */
    alsoTrackIds: z.array(z.string()).default([]),
    /** Timeline frames, end exclusive, all read against the timeline before this command. */
    ranges: z.array(z.object({ start: frames, end: positiveFrames })).min(1),
    /** Close the gaps by moving what follows earlier. */
    ripple: z.boolean().default(true),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandInput = z.input<typeof Command>;

/** Positions are source frames of the asset, so a transcript stays true however the clips are edited. */
export const TranscriptWord = z.object({
  text: z.string(),
  start: frames,
  /** Exclusive. */
  end: frames,
  probability: z.number().min(0).max(1),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const Transcript = z.object({
  assetId: z.string().min(1),
  language: z.string(),
  model: z.string(),
  segments: z.array(z.object({ words: z.array(TranscriptWord) })),
});
export type Transcript = z.infer<typeof Transcript>;

export const Actor = z.enum(["user", "agent"]);
export type Actor = z.infer<typeof Actor>;

export const HistoryEntry = z.object({
  revision: z.number().int().positive(),
  kind: z.enum(["apply", "undo", "redo"]),
  actor: Actor,
  label: z.string(),
  commands: z.array(Command),
  /** Set when this entry takes back one earlier batch and leaves later edits in place. */
  revertsRevision: z.number().int().positive().optional(),
  before: Timeline,
  after: Timeline,
  at: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;
