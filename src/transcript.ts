import { isMediaClip, type MediaClip, type Project, type Transcript } from "./schema.ts";

export interface FrameRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface TimelineWord extends FrameRange {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  filler: boolean;
}

export interface TimelineSegment extends FrameRange {
  clipId: string;
  assetId: string;
  text: string;
  words: TimelineWord[];
}

/** Sounds that carry no meaning on their own. Only a hint: "à" can also be part of a sentence. */
const FILLERS = new Set(["à", "ờ", "ừ", "ừm", "ưm", "ơ", "ờm", "hừm", "um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "mm"]);

export function isFiller(text: string): boolean {
  return FILLERS.has(text.toLowerCase().replace(/[^\p{L}]/gu, ""));
}

/** Speech lives on the first video track. Cutaways and music on other tracks are not what is being said. */
function orderedClips(project: Project): MediaClip[] {
  const main = project.timeline.tracks.find((track) => track.kind === "video");
  return (main?.clips ?? []).filter(isMediaClip).sort((a, b) => a.start - b.start);
}

/** The words as they are heard on the timeline. A word belongs to the clip holding its midpoint. */
export function timelineTranscript(project: Project, transcripts: ReadonlyMap<string, Transcript>): TimelineSegment[] {
  const result: TimelineSegment[] = [];
  for (const clip of orderedClips(project)) {
    const transcript = transcripts.get(clip.assetId);
    if (!transcript) continue;
    const sourceEnd = clip.sourceIn + clip.duration;
    const offset = clip.start - clip.sourceIn;
    for (const segment of transcript.segments) {
      const words: TimelineWord[] = [];
      for (const word of segment.words) {
        const middle = (word.start + word.end) / 2;
        if (middle < clip.sourceIn || middle >= sourceEnd) continue;
        words.push({
          text: word.text,
          start: Math.max(word.start, clip.sourceIn) + offset,
          end: Math.min(word.end, sourceEnd) + offset,
          sourceStart: word.start,
          sourceEnd: word.end,
          filler: isFiller(word.text),
        });
      }
      if (words.length === 0) continue;
      result.push({
        clipId: clip.id,
        assetId: clip.assetId,
        start: words[0]!.start,
        end: words.at(-1)!.end,
        text: words.map((word) => word.text).join(" "),
        words,
      });
    }
  }
  return result;
}

export interface SubtitleCue extends FrameRange {
  text: string;
}

/** Splits what is said into short lines to read. Each ends where the next begins at the latest. */
export function subtitleCues(segments: TimelineSegment[], maxChars = 42, minFrames = 15): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const segment of segments) {
    let line: TimelineWord[] = [];
    const flush = () => {
      if (line.length > 0) cues.push({ start: line[0]!.start, end: line.at(-1)!.end, text: line.map((word) => word.text).join(" ") });
      line = [];
    };
    for (const word of segment.words) {
      const length = line.reduce((sum, item) => sum + item.text.length + 1, word.text.length);
      if (length > maxChars) flush();
      line.push(word);
    }
    flush();
  }
  cues.sort((a, b) => a.start - b.start);
  return cues.map((cue, index) => {
    const next = cues[index + 1]?.start ?? Infinity;
    return { ...cue, end: Math.min(Math.max(cue.end, cue.start + minFrames), next) };
  });
}

/** A chosen word, described so it can be found again after someone else has changed the timeline. */
export interface WordRef {
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  /** Where it was when chosen. Tells two uses of the same source apart. */
  timelineStart: number;
}

/**
 * Where the chosen words are on this timeline, joined across the pauses between them. Words no longer
 * on the timeline are skipped. Pass the refs in reading order.
 */
export function rangesForWords(project: Project, refs: WordRef[]): FrameRange[] {
  const clips = orderedClips(project);
  const ranges: Array<FrameRange & { clipId: string }> = [];
  for (const ref of refs) {
    const middle = (ref.sourceStart + ref.sourceEnd) / 2;
    const clip = clips
      .filter((candidate) => candidate.assetId === ref.assetId && middle >= candidate.sourceIn && middle < candidate.sourceIn + candidate.duration)
      .sort((a, b) => distance(a, ref) - distance(b, ref))[0];
    if (!clip) continue;
    const offset = clip.start - clip.sourceIn;
    const start = Math.max(ref.sourceStart, clip.sourceIn) + offset;
    const end = Math.min(ref.sourceEnd, clip.sourceIn + clip.duration) + offset;
    const last = ranges.at(-1);
    if (last && last.clipId === clip.id && start >= last.start) last.end = Math.max(last.end, end);
    else ranges.push({ start, end, clipId: clip.id });
  }
  return ranges.map(({ start, end }) => ({ start, end }));
}

function distance(clip: MediaClip, ref: WordRef): number {
  return Math.abs(clip.start - clip.sourceIn + ref.sourceStart - ref.timelineStart);
}

/** Maps ranges of source frames onto the timeline, cut to what each clip uses, joined where they touch. */
export function sourceRangesOnTimeline(project: Project, bySource: ReadonlyMap<string, FrameRange[]>): Array<FrameRange & { clipIds: string[] }> {
  const result: Array<FrameRange & { clipIds: string[] }> = [];
  for (const clip of orderedClips(project)) {
    const offset = clip.start - clip.sourceIn;
    for (const range of bySource.get(clip.assetId) ?? []) {
      const from = Math.max(range.start, clip.sourceIn);
      const to = Math.min(range.end, clip.sourceIn + clip.duration);
      if (from >= to) continue;
      const last = result.at(-1);
      if (last && last.end === from + offset) {
        last.end = to + offset;
        if (!last.clipIds.includes(clip.id)) last.clipIds.push(clip.id);
      } else {
        result.push({ start: from + offset, end: to + offset, clipIds: [clip.id] });
      }
    }
  }
  return result;
}
