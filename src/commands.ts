import { shiftKeyframes, sliceAllKeyframes, DEFAULT_TRANSFORM } from "./animation.ts";
import { isMediaClip, type Asset, type Clip, type Command, type Project, type Timeline, type Track, type TrackKind } from "./schema.ts";

/** A rejected command. The message tells the caller, human or agent, how to correct it. */
export class CommandError extends Error {
  override name = "CommandError";
}

interface Found {
  track: Track;
  clip: Clip;
}

function findClip(project: Project, clipId: string): Found {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  throw new CommandError(`Không có clip "${clipId}".`);
}

function findTrack(project: Project, trackId: string): Track {
  const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new CommandError(`Không có track "${trackId}".`);
  return track;
}

function findAsset(project: Project, assetId: string): Asset {
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new CommandError(`Không có asset "${assetId}".`);
  return asset;
}

function assertWithinAsset(asset: Asset, sourceIn: number, duration: number): void {
  if (sourceIn + duration > asset.durationFrames) {
    throw new CommandError(
      `Asset "${asset.name}" chỉ có ${asset.durationFrames} frame, không thể dùng đoạn ` +
        `${sourceIn}..${sourceIn + duration}.`,
    );
  }
}

function assertNoOverlap(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
  for (let index = 1; index < track.clips.length; index++) {
    const previous = track.clips[index - 1]!;
    const current = track.clips[index]!;
    const previousEnd = previous.start + previous.duration;
    if (current.start < previousEnd) {
      throw new CommandError(
        `Clip "${current.id}" bắt đầu ở frame ${current.start}, chồng lên "${previous.id}" ` +
          `kết thúc ở frame ${previousEnd}.`,
      );
    }
  }
}

/** Each kind of track holds what it can play: pictures, sound or text. */
function assertTrackAccepts(project: Project, track: Track, clip: Clip): void {
  if (!isMediaClip(clip)) {
    if (track.kind !== "text") throw new CommandError(`Clip chữ "${clip.id}" chỉ đặt được trên track chữ, còn "${track.id}" là track ${track.kind}.`);
    return;
  }
  const asset = findAsset(project, clip.assetId);
  if (track.kind === "text") throw new CommandError(`Track chữ "${track.id}" không nhận video. Hãy dùng add_text hoặc chọn track khác.`);
  if (track.kind === "video" && !asset.hasVideo) throw new CommandError(`"${asset.name}" chỉ có tiếng, hãy đặt trên track âm thanh.`);
  if (track.kind === "audio" && !asset.hasAudio) throw new CommandError(`"${asset.name}" không có tiếng, không đặt được trên track âm thanh.`);
}

function newTrackId(project: Project, kind: TrackKind): string {
  const used = new Set(project.timeline.tracks.map((track) => track.id));
  let number = 1;
  while (used.has(`${kind}_${number}`)) number++;
  return `${kind}_${number}`;
}

/** The part of a clip from..to, counted inside the clip. Only a piece keeping the first frame keeps the transition. */
function clipPiece<T extends Clip>(clip: T, from: number, to: number, id: string, start: number): T {
  const { transitionIn, keyframes, ...rest } = clip;
  const sliced = sliceAllKeyframes(keyframes, from, to);
  return {
    ...rest,
    id,
    start,
    duration: to - from,
    ...(isMediaClip(clip) ? { sourceIn: clip.sourceIn + from } : {}),
    ...(sliced ? { keyframes: sliced } : {}),
    ...(from === 0 && transitionIn ? { transitionIn } : {}),
  } as T;
}

function newClipId(project: Project): string {
  return `clip_${project.nextClipNumber++}`;
}

/** Applies one command in place. Callers pass a copy so a failure leaves the project unchanged. */
export function applyCommand(project: Project, command: Command): string[] {
  switch (command.type) {
    case "add_clip": {
      const track = findTrack(project, command.trackId);
      assertWithinAsset(findAsset(project, command.assetId), command.sourceIn, command.duration);
      const id = newClipId(project);
      const clip: Clip = {
        id,
        assetId: command.assetId,
        start: command.start,
        sourceIn: command.sourceIn,
        duration: command.duration,
        volume: command.volume,
      };
      assertTrackAccepts(project, track, clip);
      track.clips.push(clip);
      assertNoOverlap(track);
      return [id];
    }
    case "add_text": {
      const track = findTrack(project, command.trackId);
      const id = newClipId(project);
      const clip: Clip = { id, kind: "text", start: command.start, duration: command.duration, text: command.text, style: command.style, transform: command.transform };
      assertTrackAccepts(project, track, clip);
      track.clips.push(clip);
      assertNoOverlap(track);
      return [id];
    }
    case "set_text": {
      const { clip } = findClip(project, command.clipId);
      if (isMediaClip(clip)) throw new CommandError(`Clip "${clip.id}" là video, không có chữ để sửa.`);
      if (command.text !== undefined) clip.text = command.text;
      clip.style = { ...clip.style, ...command.style };
      return [];
    }
    case "add_track": {
      const id = command.id ?? newTrackId(project, command.kind);
      if (project.timeline.tracks.some((track) => track.id === id)) throw new CommandError(`Đã có track "${id}". Hãy đặt tên khác.`);
      const track: Track = { id, kind: command.kind, clips: [] };
      // Text stays readable: a new picture track goes under the text tracks.
      const firstText = project.timeline.tracks.findIndex((candidate) => candidate.kind === "text");
      if (command.kind === "video" && firstText !== -1) project.timeline.tracks.splice(firstText, 0, track);
      else project.timeline.tracks.push(track);
      return [];
    }
    case "remove_track": {
      const track = findTrack(project, command.trackId);
      if (track.kind === "video" && project.timeline.tracks.filter((candidate) => candidate.kind === "video").length === 1) {
        throw new CommandError("Project cần ít nhất một track video, nên không xóa được track này.");
      }
      project.timeline.tracks.splice(project.timeline.tracks.indexOf(track), 1);
      return [];
    }
    case "set_transform": {
      const { clip } = findClip(project, command.clipId);
      const { type: _type, clipId: _clipId, fit, ...values } = command;
      clip.transform = { ...DEFAULT_TRANSFORM, ...clip.transform, ...definedValues(values) };
      if (fit !== undefined) {
        if (!isMediaClip(clip)) throw new CommandError(`Clip chữ "${clip.id}" không có kiểu lấp khung.`);
        clip.fit = fit;
      }
      return [];
    }
    case "set_keyframes": {
      const { clip } = findClip(project, command.clipId);
      if (command.property === "volume" && !isMediaClip(clip)) throw new CommandError(`Clip chữ "${clip.id}" không có âm lượng.`);
      const sorted = [...command.keyframes].sort((a, b) => a.frame - b.frame);
      for (const [index, key] of sorted.entries()) {
        if (key.frame >= clip.duration) throw new CommandError(`Clip "${clip.id}" dài ${clip.duration} frame, không đặt được keyframe ở frame ${key.frame}. Vị trí tính từ đầu clip.`);
        if (index > 0 && sorted[index - 1]!.frame === key.frame) throw new CommandError(`Có hai keyframe cùng ở frame ${key.frame}.`);
        assertKeyframeValue(command.property, key.value);
      }
      const keyframes = { ...clip.keyframes };
      if (sorted.length > 0) keyframes[command.property] = sorted;
      else delete keyframes[command.property];
      if (Object.keys(keyframes).length > 0) clip.keyframes = keyframes;
      else delete clip.keyframes;
      return [];
    }
    case "set_transition": {
      const { clip } = findClip(project, command.clipId);
      if (command.transition === null) {
        delete clip.transitionIn;
        return [];
      }
      if (command.transition.duration > clip.duration) {
        throw new CommandError(`Transition dài ${command.transition.duration} frame nhưng clip "${clip.id}" chỉ dài ${clip.duration} frame.`);
      }
      clip.transitionIn = command.transition;
      return [];
    }
    case "set_canvas": {
      if (command.width % 2 !== 0 || command.height % 2 !== 0) {
        throw new CommandError(`Khung ${command.width} × ${command.height} không hợp lệ: chiều rộng và chiều cao phải là số chẵn.`);
      }
      project.width = command.width;
      project.height = command.height;
      project.timeline.canvas = { width: command.width, height: command.height };
      return [];
    }
    case "split_clip": {
      const { track, clip } = findClip(project, command.clipId);
      const offset = command.at - clip.start;
      if (offset <= 0 || offset >= clip.duration) {
        throw new CommandError(
          `Clip "${clip.id}" nằm ở frame ${clip.start}..${clip.start + clip.duration}, ` +
            `không thể cắt tại frame ${command.at}.`,
        );
      }
      const id = newClipId(project);
      const total = clip.duration;
      track.clips.push(clipPiece(clip, offset, total, id, command.at));
      Object.assign(clip, { duration: offset });
      if (clip.keyframes) clip.keyframes = sliceAllKeyframes(clip.keyframes, 0, offset)!;
      assertNoOverlap(track);
      return [id];
    }
    case "trim_clip": {
      const { track, clip } = findClip(project, command.clipId);
      const before = clip.duration;
      const oldEnd = clip.start + clip.duration;
      const others = track.clips.filter((other) => other !== clip);
      if (command.edge === "start") {
        // With a neighbour in the way the start stays against it, and the clip grows towards the later clips.
        const previousEnd = others.filter((other) => other.start < clip.start).reduce((end, other) => Math.max(end, other.start + other.duration), 0);
        clip.start = command.ripple && command.delta < 0 ? Math.max(clip.start + command.delta, previousEnd) : clip.start + command.delta;
        if (isMediaClip(clip)) clip.sourceIn += command.delta;
        clip.duration -= command.delta;
      } else {
        clip.duration += command.delta;
      }
      if (clip.start < 0 || (isMediaClip(clip) && clip.sourceIn < 0)) {
        throw new CommandError(`Không thể kéo đầu clip "${clip.id}" sớm thêm ${-command.delta} frame.`);
      }
      if (clip.duration <= 0) {
        throw new CommandError(`Clip "${clip.id}" phải còn ít nhất 1 frame sau khi trim.`);
      }
      if (isMediaClip(clip)) assertWithinAsset(findAsset(project, clip.assetId), clip.sourceIn, clip.duration);
      // Keyframes stay on the same picture when the start moves.
      if (command.edge === "start" && clip.keyframes) {
        clip.keyframes = (command.delta > 0 ? sliceAllKeyframes(clip.keyframes, command.delta, before) : shiftKeyframes(clip.keyframes, -command.delta))!;
      }
      if (command.ripple) {
        const later = others.filter((other) => other.start >= oldEnd);
        const nextStart = later.reduce((start, other) => Math.min(start, other.start), Infinity);
        const push = clip.start + clip.duration - nextStart;
        if (push > 0) {
          for (const other of later) other.start += push;
          for (const id of command.alsoTrackIds) {
            const linked = findTrack(project, id);
            if (linked === track) continue;
            for (const other of linked.clips) {
              if (other.start >= oldEnd) other.start += push;
            }
            assertNoOverlap(linked);
          }
        }
      }
      assertNoOverlap(track);
      return [];
    }
    case "move_clip": {
      const { track, clip } = findClip(project, command.clipId);
      clip.start = command.start;
      if (command.trackId && command.trackId !== track.id) {
        const target = findTrack(project, command.trackId);
        assertTrackAccepts(project, target, clip);
        track.clips.splice(track.clips.indexOf(clip), 1);
        target.clips.push(clip);
        assertNoOverlap(target);
      }
      assertNoOverlap(track);
      return [];
    }
    case "delete_clip": {
      const { track, clip } = findClip(project, command.clipId);
      track.clips.splice(track.clips.indexOf(clip), 1);
      if (command.ripple) {
        for (const later of track.clips) {
          if (later.start > clip.start) later.start -= clip.duration;
        }
      }
      return [];
    }
    case "set_volume": {
      const { clip } = findClip(project, command.clipId);
      if (!isMediaClip(clip)) throw new CommandError(`Clip chữ "${clip.id}" không có âm lượng.`);
      clip.volume = command.volume;
      return [];
    }
    case "delete_ranges": {
      const tracks = [...new Set([command.trackId, ...command.alsoTrackIds])].map((id) => findTrack(project, id));
      const ranges = mergeRanges(command.ranges);
      const removedBefore = (frame: number) =>
        ranges.reduce((total, range) => total + Math.max(0, Math.min(range.end, frame) - range.start), 0);
      const created: string[] = [];
      let touched = false;
      for (const track of tracks) {
        const kept: Clip[] = [];
        for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
          const clipEnd = clip.start + clip.duration;
          const pieces: Array<[number, number]> = [];
          let cursor = clip.start;
          for (const range of ranges) {
            if (range.end <= cursor) continue;
            if (range.start >= clipEnd) break;
            if (range.start > cursor) pieces.push([cursor, range.start]);
            cursor = range.end;
          }
          if (cursor < clipEnd) pieces.push([cursor, clipEnd]);
          const unchanged = pieces.length === 1 && pieces[0]![1] - pieces[0]![0] === clip.duration;
          if (!unchanged) touched = true;
          pieces.forEach(([from, to], index) => {
            // As with a split, the first piece keeps the clip's id.
            const id = index === 0 ? clip.id : newClipId(project);
            if (index > 0) created.push(id);
            const start = command.ripple ? from - removedBefore(from) : from;
            kept.push(unchanged ? { ...clip, start } : clipPiece(clip, from - clip.start, to - clip.start, id, start));
          });
        }
        track.clips = kept;
        assertNoOverlap(track);
      }
      if (!touched) throw new CommandError("Các đoạn cần xóa không chạm vào clip nào. Hãy đọc lại timeline.");
      return created;
    }
  }
}

function definedValues<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function assertKeyframeValue(property: string, value: number): void {
  const limits: Record<string, [number, number]> = { x: [-2, 2], y: [-2, 2], scale: [0.01, 10], opacity: [0, 1], volume: [0, 200] };
  const [low, high] = limits[property]!;
  if (value < low || value > high) throw new CommandError(`Giá trị ${value} của ${property} nằm ngoài khoảng ${low}..${high}.`);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = [];
  for (const { start, end } of [...ranges].sort((a, b) => a.start - b.start)) {
    if (end <= start) throw new CommandError(`Đoạn frame ${start}..${end} không hợp lệ: điểm cuối phải sau điểm đầu.`);
    const last = merged.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

type PlacedClip = Clip & { trackId: string };

function placedClips(timeline: Timeline): Map<string, PlacedClip> {
  return new Map(timeline.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, { ...clip, trackId: track.id }] as const)));
}

function changedFields(a: PlacedClip, b: PlacedClip): string[] {
  const one = a as unknown as Record<string, unknown>;
  const two = b as unknown as Record<string, unknown>;
  // Effects are nested and optional, so compare by value over the fields of both.
  return [...new Set([...Object.keys(one), ...Object.keys(two)])].filter((field) => JSON.stringify(one[field]) !== JSON.stringify(two[field]));
}

export interface ClipChanges {
  added: string[];
  removed: string[];
  modified: string[];
}

export function diffTimelines(before: Timeline, after: Timeline): ClipChanges {
  const old = placedClips(before);
  const next = placedClips(after);
  return {
    added: [...next.keys()].filter((id) => !old.has(id)),
    removed: [...old.keys()].filter((id) => !next.has(id)),
    modified: [...next].filter(([id, clip]) => old.has(id) && changedFields(old.get(id)!, clip).length > 0).map(([id]) => id),
  };
}

/**
 * Takes one earlier batch back out of the project and keeps everything done since. A clip the batch
 * touched must still hold what the batch left there, otherwise the two edits conflict and nothing changes.
 */
export function revertChanges(project: Project, before: Timeline, after: Timeline): void {
  const old = placedClips(before);
  const next = placedClips(after);
  const current = placedClips(project.timeline);
  const conflict = (id: string) =>
    new CommandError(`Không thể hoàn tác riêng lô này vì clip "${id}" đã được sửa sau đó. Hãy hoàn tác thay đổi đó trước.`);

  // Tracks the batch removed come back first, in their old place, so their clips have somewhere to go.
  const trackIds = (timeline: Timeline) => new Set(timeline.tracks.map((track) => track.id));
  const hadAfter = trackIds(after);
  before.tracks.forEach((track, index) => {
    if (!hadAfter.has(track.id) && !project.timeline.tracks.some((existing) => existing.id === track.id)) {
      project.timeline.tracks.splice(Math.min(index, project.timeline.tracks.length), 0, { id: track.id, kind: track.kind, clips: [] });
    }
  });

  const { added, removed, modified } = diffTimelines(before, after);
  for (const id of added) {
    const clip = current.get(id);
    if (clip && changedFields(clip, next.get(id)!).length > 0) throw conflict(id);
    current.delete(id);
  }
  for (const id of removed) current.set(id, old.get(id)!);
  for (const id of modified) {
    const clip = current.get(id);
    if (!clip) throw conflict(id);
    const values = clip as unknown as Record<string, unknown>;
    const wanted = old.get(id)! as unknown as Record<string, unknown>;
    const left = next.get(id)! as unknown as Record<string, unknown>;
    for (const field of changedFields(old.get(id)!, next.get(id)!)) {
      if (JSON.stringify(values[field]) !== JSON.stringify(left[field])) throw conflict(id);
      if (wanted[field] === undefined) delete values[field];
      else values[field] = wanted[field];
    }
  }

  for (const track of project.timeline.tracks) {
    track.clips = [...current.values()]
      .filter((clip) => clip.trackId === track.id)
      .map(({ trackId: _trackId, ...clip }) => clip as Clip);
    assertNoOverlap(track);
    for (const clip of track.clips) {
      if (isMediaClip(clip)) assertWithinAsset(findAsset(project, clip.assetId), clip.sourceIn, clip.duration);
    }
  }

  // Tracks the batch added go away with it, unless someone has used them since.
  const hadBefore = trackIds(before);
  project.timeline.tracks = project.timeline.tracks.filter((track) => {
    if (hadBefore.has(track.id) || !hadAfter.has(track.id)) return true;
    if (track.clips.length > 0) throw new CommandError(`Không thể hoàn tác riêng lô này vì track "${track.id}" đã có clip mới. Hãy xóa các clip đó trước.`);
    return false;
  });

  if (JSON.stringify(before.canvas) !== JSON.stringify(after.canvas) && before.canvas) {
    if (project.width !== after.canvas?.width || project.height !== after.canvas?.height) {
      throw new CommandError("Không thể hoàn tác riêng lô này vì khung hình đã được đổi sau đó. Hãy hoàn tác thay đổi đó trước.");
    }
    project.width = before.canvas.width;
    project.height = before.canvas.height;
    project.timeline.canvas = before.canvas;
  }
}
