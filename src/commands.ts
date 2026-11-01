import type { Asset, Clip, Command, Project, Track } from "./schema.ts";

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
      track.clips.push({
        id,
        assetId: command.assetId,
        start: command.start,
        sourceIn: command.sourceIn,
        duration: command.duration,
        volume: command.volume,
      });
      assertNoOverlap(track);
      return [id];
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
      track.clips.push({
        ...clip,
        id,
        start: command.at,
        sourceIn: clip.sourceIn + offset,
        duration: clip.duration - offset,
      });
      clip.duration = offset;
      assertNoOverlap(track);
      return [id];
    }
    case "trim_clip": {
      const { track, clip } = findClip(project, command.clipId);
      const asset = findAsset(project, clip.assetId);
      if (command.edge === "start") {
        clip.start += command.delta;
        clip.sourceIn += command.delta;
        clip.duration -= command.delta;
      } else {
        clip.duration += command.delta;
      }
      if (clip.start < 0 || clip.sourceIn < 0) {
        throw new CommandError(`Không thể kéo đầu clip "${clip.id}" sớm thêm ${-command.delta} frame.`);
      }
      if (clip.duration <= 0) {
        throw new CommandError(`Clip "${clip.id}" phải còn ít nhất 1 frame sau khi trim.`);
      }
      assertWithinAsset(asset, clip.sourceIn, clip.duration);
      assertNoOverlap(track);
      return [];
    }
    case "move_clip": {
      const { track, clip } = findClip(project, command.clipId);
      clip.start = command.start;
      if (command.trackId && command.trackId !== track.id) {
        const target = findTrack(project, command.trackId);
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
      findClip(project, command.clipId).clip.volume = command.volume;
      return [];
    }
  }
}
