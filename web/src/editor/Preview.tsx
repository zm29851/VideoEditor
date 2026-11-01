import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { lookAt, trackEnvelopes } from "../../../src/animation.ts";
import { isMediaClip, type TextClip } from "../../../src/schema.ts";
import { frameToTimecode } from "../../../src/time.ts";
import { urls } from "../api.ts";
import { Digits, IconButton, useCssVars } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import { timelineEnd } from "./timelineOps.ts";
import styles from "./Editor.module.css";

function Transport() {
  const { player, project, clips } = useEditor();
  const { frame, playing } = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const disabled = clips.length === 0;
  return (
    <div className={styles.transport}>
      <output className={styles.timecodeMain} aria-label="Vị trí hiện tại">
        <Digits value={frameToTimecode(frame, project.fps)} />
      </output>
      <div className={styles.transportButtons}>
        <IconButton label="Lùi một frame" shortcut="←" onClick={() => player.step(-1)} disabled={disabled}>
          <SkipBack size={18} aria-hidden />
        </IconButton>
        <button
          type="button"
          className={styles.playButton}
          aria-label={playing ? "Dừng" : "Phát"}
          onClick={() => player.toggle()}
          disabled={disabled}
        >
          {playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
        </button>
        <IconButton label="Tiến một frame" shortcut="→" onClick={() => player.step(1)} disabled={disabled}>
          <SkipForward size={18} aria-hidden />
        </IconButton>
      </div>
      <span className={styles.timecodeTotal} aria-label="Tổng thời lượng">
        <Digits value={frameToTimecode(timelineEnd(clips), project.fps)} />
      </span>
    </div>
  );
}

/** Short and stable: it only has to change when the text, its look or the frame size does. */
function textVersion(clip: TextClip, width: number, height: number): string {
  let hash = 5381;
  for (const char of JSON.stringify([clip.text, clip.style, width, height])) hash = (hash * 33 + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}

function TextLayer({ clip, frame, src, z, envelope }: { clip: TextClip; frame: number; src: string; z: number; envelope: ReturnType<typeof trackEnvelopes> }) {
  const look = lookAt(clip, frame - clip.start, envelope.get(clip.id));
  const ref = useCssVars<HTMLImageElement>({ "--layer-x": look.x, "--layer-y": look.y, "--layer-scale": look.scale, "--layer-opacity": look.opacity, "--layer-z": z });
  return <img ref={ref} className={styles.deck} data-visible="true" src={src} alt={clip.text} draggable={false} />;
}

/** The same pictures the export draws. All of them load ahead, so a subtitle never appears late. */
function TextLayers() {
  const { player, project, projectId } = useEditor();
  const { frame } = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const tracks = useMemo(
    () =>
      project.timeline.tracks.flatMap((track, index) =>
        track.kind !== "text"
          ? []
          : [{
              z: index * 10 + 1,
              envelope: trackEnvelopes(track.clips, project.assets),
              clips: track.clips
                .filter((clip): clip is TextClip => !isMediaClip(clip))
                .map((clip) => ({ clip, src: urls.textImage(projectId, clip.id, textVersion(clip, project.width, project.height)) })),
            }],
      ),
    [project.timeline.tracks, project.assets, project.width, project.height, projectId],
  );
  useEffect(() => {
    for (const track of tracks) {
      for (const { src } of track.clips) new Image().src = src;
    }
  }, [tracks]);
  return tracks.flatMap((track) =>
    track.clips
      .filter(({ clip }) => frame >= clip.start && frame < clip.start + clip.duration)
      .map(({ clip, src }) => <TextLayer key={clip.id} clip={clip} frame={frame} src={src} z={track.z} envelope={track.envelope} />),
  );
}

export function Preview() {
  const { player, projectId, project, clips } = useEditor();
  const deckA = useRef<HTMLVideoElement>(null);
  const deckB = useRef<HTMLVideoElement>(null);
  const stage = useCssVars<HTMLDivElement>({ "--preview-aspect": project.width / project.height });
  const decks = useRef<HTMLDivElement>(null);

  useEffect(() => {
    player.attach(deckA.current!, deckB.current!, (assetId) => urls.proxy(projectId, assetId), decks.current!);
    return () => player.detach();
  }, [player, projectId]);

  return (
    <section className={styles.preview} aria-label="Xem trước">
      <div className={styles.stageArea}>
        <div ref={stage} className={styles.stage}>
          <div ref={decks} className={styles.layers}>
            <video ref={deckA} className={styles.deck} playsInline preload="auto" data-visible="false" />
            <video ref={deckB} className={styles.deck} playsInline preload="auto" data-visible="false" />
            <TextLayers />
          </div>
          {clips.length === 0 && <p className={styles.stageEmpty}>Thêm video vào timeline để xem trước.</p>}
        </div>
      </div>
      <Transport />
    </section>
  );
}
