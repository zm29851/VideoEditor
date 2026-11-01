import { ArrowLeftToLine, Magnet, Maximize2, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Asset, Clip, CommandInput } from "../../../src/schema.ts";
import { framesToSeconds, frameToTimecode } from "../../../src/time.ts";
import { api, urls } from "../api.ts";
import { IconButton, Slider, useCssVars } from "../ui/ui.tsx";
import { MAX_PX_PER_FRAME, MIN_PX_PER_FRAME, useEditor } from "./Editor.tsx";
import { ASSET_DRAG_TYPE, assetDrag } from "./Library.tsx";
import { clipEnd, cutPoints, resolveMove, resolveTrim, rulerStep, timelineEnd, type SnapOptions } from "./timelineOps.ts";
import { Waveform } from "./Waveform.tsx";
import styles from "./Timeline.module.css";

const SNAP_DISTANCE_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const PLAYHEAD_MARGIN_PX = 48;
/** Empty room after the last clip, as a share of the timeline, so a clip can be dropped there. */
const TAIL_SHARE = 0.25;
const MIN_CONTENT_FRAMES = 600;

type Layout = Pick<Clip, "start" | "sourceIn" | "duration">;

interface Drag {
  clipId: string;
  edge?: "start" | "end";
  layout: Layout;
}

function usePeaks(projectId: string, assets: Asset[]): Map<string, number[]> {
  const [peaks, setPeaks] = useState(new Map<string, number[]>());
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const asset of assets) {
      if (!asset.hasAudio || requested.current.has(asset.id)) continue;
      requested.current.add(asset.id);
      api.peaks(projectId, asset.id).then(
        (values) => setPeaks((current) => new Map(current).set(asset.id, values)),
        () => requested.current.delete(asset.id),
      );
    }
  }, [projectId, assets]);
  return peaks;
}

function Tick({ frame, label }: { frame: number; label: string }) {
  const ref = useCssVars<HTMLSpanElement>({ "--tick-frame": frame });
  return (
    <span ref={ref} className={styles.tick}>
      {label}
    </span>
  );
}

function ClipBlock({
  className,
  layout,
  selected,
  onPointerDown,
  children,
  label,
  isButton,
  onClickKey,
}: {
  className: string | undefined;
  layout: Layout;
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  children: React.ReactNode;
  label?: string;
  isButton?: boolean;
  onClickKey?: () => void;
}) {
  const vars = { "--clip-start": layout.start, "--clip-duration": layout.duration };
  const buttonRef = useCssVars<HTMLButtonElement>(vars);
  const divRef = useCssVars<HTMLDivElement>(vars);
  const shared = `${styles.clip} ${className} ${selected ? styles.selected : ""}`;
  if (isButton) {
    return (
      <button
        ref={buttonRef}
        type="button"
        data-clip
        className={shared}
        aria-label={label}
        aria-pressed={selected}
        onPointerDown={onPointerDown}
        onClick={onClickKey}
      >
        {children}
      </button>
    );
  }
  return (
    <div ref={divRef} className={shared} aria-hidden onPointerDown={onPointerDown}>
      {children}
    </div>
  );
}

function Playhead({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const { player, pxPerFrame } = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      ref.current?.style.setProperty("--playhead-frame", String(player.frame));
      const view = scroller.current;
      if (!view) return;
      const x = player.frame * pxPerFrame;
      if (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth - PLAYHEAD_MARGIN_PX) {
        view.scrollLeft = Math.max(0, x - PLAYHEAD_MARGIN_PX);
      }
    };
    update();
    return player.subscribe(update);
  }, [player, pxPerFrame, scroller]);
  return <div ref={ref} className={styles.playhead} aria-hidden />;
}

function Ghost({ start, duration }: { start: number; duration: number }) {
  const ref = useCssVars<HTMLDivElement>({ "--clip-start": start, "--clip-duration": duration });
  return <div ref={ref} className={styles.ghost} aria-hidden />;
}

export function Timeline() {
  const editor = useEditor();
  const { project, projectId, clips, player, selectedId, select, dispatch, snap, pxPerFrame, setPxPerFrame, fitRequest } = editor;
  const { fps } = project;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const [ghost, setGhost] = useState<{ start: number; duration: number }>();
  const peaks = usePeaks(projectId, project.assets);
  const end = timelineEnd(clips);
  const contentFrames = Math.max(MIN_CONTENT_FRAMES, Math.ceil(end * (1 + TAIL_SHARE)));

  useLayoutEffect(() => {
    content.current?.style.setProperty("--px-per-frame", String(pxPerFrame));
    content.current?.style.setProperty("--content-frames", String(contentFrames));
  }, [pxPerFrame, contentFrames]);

  const fit = useCallback(() => {
    const width = scroller.current?.clientWidth ?? 0;
    if (width > 0) setPxPerFrame(width / Math.max(end * (1 + TAIL_SHARE / 2), MIN_CONTENT_FRAMES / 4));
  }, [end, setPxPerFrame]);

  useEffect(() => {
    if (fitRequest > 0) fit();
  }, [fitRequest]);

  // The whole timeline fits when a project opens, and when the first clip arrives.
  const hadClips = useRef(false);
  useEffect(() => {
    if (end > 0 && !hadClips.current) fit();
    hadClips.current = end > 0;
  }, [end, fit]);

  const frameAt = (clientX: number) => {
    const rect = content.current!.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left) / pxPerFrame));
  };

  const snapFor = (excludeId: string | undefined): SnapOptions | undefined =>
    snap
      ? {
          targets: [...cutPoints(clips.filter((clip) => clip.id !== excludeId)), player.frame],
          tolerance: Math.max(1, Math.round(SNAP_DISTANCE_PX / pxPerFrame)),
        }
      : undefined;

  const scrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    player.seek(frameAt(event.clientX));
    const move = (moved: PointerEvent) => player.seek(frameAt(moved.clientX));
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  const startClipDrag = (event: ReactPointerEvent<HTMLElement>, clip: Clip, asset: Asset) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    select(clip.id);
    const edge = (event.target as HTMLElement).dataset.edge as "start" | "end" | undefined;
    const originX = event.clientX;
    const others = clips.filter((other) => other.id !== clip.id);
    const snapOptions = snapFor(clip.id);
    let moved = false;
    let layout: Layout = clip;

    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - originX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      const frames = Math.round(dx / pxPerFrame);
      if (edge) {
        const reference = edge === "start" ? clip.start : clipEnd(clip);
        layout = resolveTrim(clip, asset, others, edge, reference + frames, snapOptions);
      } else {
        layout = { ...clip, start: resolveMove(others, clip.duration, clip.start + frames, snapOptions) };
      }
      setDrag({ clipId: clip.id, ...(edge ? { edge } : {}), layout });
    };
    const finish = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
    };
    const cancel = () => {
      finish();
      setDrag(undefined);
    };
    const up = () => {
      finish();
      let command: CommandInput | undefined;
      let label = "";
      if (edge === "start" && layout.start !== clip.start) {
        command = { type: "trim_clip", clipId: clip.id, edge, delta: layout.start - clip.start };
        label = "Cắt bớt đầu clip";
      } else if (edge === "end" && layout.duration !== clip.duration) {
        command = { type: "trim_clip", clipId: clip.id, edge, delta: layout.duration - clip.duration };
        label = "Cắt bớt cuối clip";
      } else if (!edge && layout.start !== clip.start) {
        command = { type: "move_clip", clipId: clip.id, start: layout.start };
        label = "Di chuyển clip";
      }
      if (command) void dispatch(label, [command]).finally(() => setDrag(undefined));
      else setDrag(undefined);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
  };

  const draggedAsset = () => project.assets.find((asset) => asset.id === assetDrag.assetId);

  const onDragOver = (event: DragEvent) => {
    const asset = draggedAsset();
    if (!asset || !event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setGhost({ start: resolveMove(clips, asset.durationFrames, frameAt(event.clientX), snapFor(undefined)), duration: asset.durationFrames });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const asset = draggedAsset();
    if (asset && ghost) editor.addAsset(asset, ghost.start);
    setGhost(undefined);
  };

  const step = rulerStep(pxPerFrame, fps);
  const ticks: number[] = [];
  for (let frame = 0; frame <= contentFrames; frame += step) ticks.push(frame);

  const zoomValue = Math.log(pxPerFrame);
  const selected = selectedId !== undefined && clips.some((clip) => clip.id === selectedId);

  return (
    <section className={styles.timeline} aria-label="Timeline">
      <div className={styles.toolbar}>
        <IconButton label="Cắt clip tại playhead" shortcut="S" onClick={editor.cut} disabled={clips.length === 0}>
          <Scissors size={18} aria-hidden />
        </IconButton>
        <IconButton label="Xóa clip" shortcut="Delete" onClick={() => editor.remove(false)} disabled={!selected}>
          <Trash2 size={18} aria-hidden />
        </IconButton>
        <IconButton label="Xóa và dồn" shortcut="⇧Delete" onClick={() => editor.remove(true)} disabled={!selected}>
          <ArrowLeftToLine size={18} aria-hidden />
        </IconButton>
        <IconButton label="Bám điểm cắt" shortcut="N" pressed={snap} onClick={editor.toggleSnap}>
          <Magnet size={18} aria-hidden />
        </IconButton>
        <div className={styles.grow} />
        <IconButton label="Thu nhỏ timeline" shortcut="−" onClick={() => editor.zoom(-1)}>
          <ZoomOut size={18} aria-hidden />
        </IconButton>
        <div className={styles.zoomSlider}>
          <Slider
            label="Mức phóng timeline"
            value={zoomValue}
            min={Math.log(MIN_PX_PER_FRAME)}
            max={Math.log(MAX_PX_PER_FRAME)}
            step={0.01}
            onChange={(value) => setPxPerFrame(Math.exp(value))}
          />
        </div>
        <IconButton label="Phóng to timeline" shortcut="+" onClick={() => editor.zoom(1)}>
          <ZoomIn size={18} aria-hidden />
        </IconButton>
        <IconButton label="Vừa khít timeline" shortcut="⇧Z" onClick={fit} disabled={clips.length === 0}>
          <Maximize2 size={18} aria-hidden />
        </IconButton>
      </div>

      <div className={styles.body}>
        <div className={styles.labels} aria-hidden>
          <div className={styles.labelRuler} />
          <div className={styles.labelVideo}>Hình</div>
          <div className={styles.labelAudio}>Tiếng</div>
        </div>
        <div ref={scroller} className={styles.scroller}>
          <div ref={content} className={styles.content}>
            <div className={styles.ruler} onPointerDown={scrub}>
              {ticks.map((frame) => (
                <Tick key={frame} frame={frame} label={frameToTimecode(frame, fps)} />
              ))}
            </div>
            <div
              className={styles.tracks}
              onPointerDown={(event) => {
                select(undefined);
                scrub(event);
              }}
              onDragOver={onDragOver}
              onDragLeave={() => setGhost(undefined)}
              onDrop={onDrop}
            >
              <div className={styles.trackVideo}>
                {clips.map((clip) => {
                  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
                  if (!asset) return null;
                  const layout = drag?.clipId === clip.id ? drag.layout : clip;
                  return (
                    <ClipBlock
                      key={clip.id}
                      isButton
                      className={styles.clipVideo}
                      layout={layout}
                      selected={clip.id === selectedId}
                      label={`${asset.name}, bắt đầu ${frameToTimecode(layout.start, fps)}, dài ${frameToTimecode(layout.duration, fps)}`}
                      onPointerDown={(event) => startClipDrag(event, clip, asset)}
                      onClickKey={() => select(clip.id)}
                    >
                      <span data-edge="start" className={styles.handleStart} />
                      <img
                        className={styles.clipThumb}
                        src={urls.thumbnail(projectId, asset.id, clip.sourceIn)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                      <span className={styles.clipName}>{asset.name}</span>
                      <span data-edge="end" className={styles.handleEnd} />
                    </ClipBlock>
                  );
                })}
              </div>
              <div className={styles.trackAudio}>
                {clips.map((clip) => {
                  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
                  if (!asset) return null;
                  const assetPeaks = peaks.get(asset.id);
                  return (
                    <ClipBlock
                      key={clip.id}
                      className={styles.clipAudio}
                      layout={drag?.clipId === clip.id ? drag.layout : clip}
                      selected={clip.id === selectedId}
                      onPointerDown={(event) => startClipDrag(event, clip, asset)}
                    >
                      {assetPeaks && assetPeaks.length > 0 ? (
                        <Waveform peaks={assetPeaks} sourceIn={clip.sourceIn} duration={clip.duration} seconds={framesToSeconds(clip.duration, fps)} />
                      ) : (
                        !asset.hasAudio && <span className={styles.noAudio}>Không có tiếng</span>
                      )}
                    </ClipBlock>
                  );
                })}
              </div>
              {ghost && <Ghost start={ghost.start} duration={ghost.duration} />}
              {clips.length === 0 && !ghost && <p className={styles.empty}>Kéo video từ Thư viện vào đây, hoặc bấm dấu cộng cạnh video.</p>}
            </div>
            <Playhead scroller={scroller} />
          </div>
        </div>
      </div>
    </section>
  );
}
