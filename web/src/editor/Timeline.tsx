import { ArrowLeftToLine, Blend, Bot, Check, Clapperboard, Magnet, Maximize2, Music, Scissors, Trash2, Type, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { isMediaClip, type Asset, type Clip, type CommandInput, type Track } from "../../../src/schema.ts";
import { framesToSeconds, frameToTimecode } from "../../../src/time.ts";
import { api, urls } from "../api.ts";
import { Button, IconButton, Slider, useCssVars } from "../ui/ui.tsx";
import { describeChanges } from "./agentNotice.ts";
import { MAX_PX_PER_FRAME, MIN_PX_PER_FRAME, useEditor } from "./Editor.tsx";
import { ASSET_DRAG_TYPE, assetDrag } from "./Library.tsx";
import { clipEnd, cutPoints, resolveMove, resolveTrim, rulerStep, timelineEnd, trackAccepts, type SnapOptions } from "./timelineOps.ts";
import { Waveform } from "./Waveform.tsx";
import styles from "./Timeline.module.css";

const SNAP_DISTANCE_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const PLAYHEAD_MARGIN_PX = 48;
/** Empty room after the last clip, as a share of the timeline, so a clip can be dropped there. */
const TAIL_SHARE = 0.25;
const MIN_CONTENT_FRAMES = 600;

type Layout = { start: number; duration: number };

interface Drag {
  clipId: string;
  edge?: "start" | "end";
  layout: Layout;
  trackId: string;
}

/** The track row under the pointer, whichever element the pointer is captured by. */
function trackIdAt(x: number, y: number): string | undefined {
  for (const element of document.elementsFromPoint(x, y)) {
    const id = (element as HTMLElement).dataset?.trackId;
    if (id) return id;
  }
  return undefined;
}

const TRACK_NAMES: Record<Track["kind"], string> = { video: "Hình", audio: "Âm thanh", text: "Chữ" };

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
  byAgent,
  onPointerDown,
  children,
  label,
  isButton,
  onClickKey,
}: {
  className: string | undefined;
  layout: Layout;
  selected: boolean;
  byAgent: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  children: React.ReactNode;
  label?: string;
  isButton?: boolean;
  onClickKey?: () => void;
}) {
  const vars = { "--clip-start": layout.start, "--clip-duration": layout.duration };
  const buttonRef = useCssVars<HTMLButtonElement>(vars);
  const divRef = useCssVars<HTMLDivElement>(vars);
  const shared = `${styles.clip} ${className} ${byAgent ? styles.byAgent : ""} ${selected ? styles.selected : ""}`;
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

function TrackLabel({ track, name, removable, spaced }: { track: Track; name: string; removable: boolean; spaced: boolean }) {
  const { dispatch } = useEditor();
  const short = track.kind === "audio" ? styles.labelAudio : styles.labelVideo;
  return (
    <div className={`${short} ${spaced ? styles.labelAudioSpaced : ""}`}>
      <span>{name}</span>
      {removable && (
        <IconButton label={`Xóa track ${name}`} onClick={() => void dispatch(`Xóa track ${name}`, [{ type: "remove_track", trackId: track.id }])}>
          <X size={14} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

function Ghost({ start, duration }: { start: number; duration: number }) {
  const ref = useCssVars<HTMLDivElement>({ "--clip-start": start, "--clip-duration": duration });
  return <div ref={ref} className={styles.ghost} aria-hidden />;
}

function AgentNotice() {
  const { unseenAgent, revertBatch, markAgentSeen } = useEditor();
  const latest = unseenAgent[0];
  if (!latest) return null;
  const changes = describeChanges(latest.changes);
  const others = unseenAgent.length - 1;
  return (
    <div className={styles.notice} role="status">
      <Bot size={18} aria-hidden />
      <p className={styles.noticeText}>
        <strong>Agent vừa sửa:</strong> {latest.label}
        {changes && ` (${changes})`}
        {others > 0 && `, và ${others} lô khác`}
      </p>
      {latest.revertible && (
        <Button variant="ghost" className={styles.noticeAction} onClick={() => revertBatch(latest)}>
          <Undo2 size={16} aria-hidden />
          Hoàn tác lô này
        </Button>
      )}
      <Button variant="ghost" className={styles.noticeAction} onClick={markAgentSeen}>
        <Check size={16} aria-hidden />
        Đã xem
      </Button>
    </div>
  );
}

export function Timeline() {
  const editor = useEditor();
  const { project, projectId, clips, tracks, trackId: mainTrackId, player, selectedId, select, dispatch, snap, pxPerFrame, setPxPerFrame, fitRequest } = editor;
  const { fps } = project;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const [ghost, setGhost] = useState<{ start: number; duration: number; trackId: string }>();
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

  const startClipDrag = (event: ReactPointerEvent<HTMLElement>, clip: Clip, track: Track) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    select(clip.id);
    const edge = (event.target as HTMLElement).dataset.edge as "start" | "end" | undefined;
    const asset = isMediaClip(clip) ? project.assets.find((candidate) => candidate.id === clip.assetId) : undefined;
    const originX = event.clientX;
    const snapOptions = snapFor(clip.id);
    let moved = false;
    let layout: Layout = clip;
    let target = track;

    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - originX;
      const overId = edge ? undefined : trackIdAt(pointer.clientX, pointer.clientY);
      const over = tracks.find((candidate) => candidate.id === overId);
      const nextTarget = over && trackAccepts(over, clip, project.assets) ? over : target;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX && nextTarget === target) return;
      moved = true;
      target = nextTarget;
      const others = target.clips.filter((other) => other.id !== clip.id);
      const frames = Math.round(dx / pxPerFrame);
      if (edge) {
        const reference = edge === "start" ? clip.start : clipEnd(clip);
        layout = resolveTrim(clip, asset, others, edge, reference + frames, snapOptions);
      } else {
        layout = { start: resolveMove(others, clip.duration, clip.start + frames, snapOptions), duration: clip.duration };
      }
      setDrag({ clipId: clip.id, ...(edge ? { edge } : {}), layout, trackId: target.id });
    };
    // On the window: moving to another track remounts the clip, and the listeners must outlive that.
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
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
      } else if (!edge && (layout.start !== clip.start || target !== track)) {
        command = { type: "move_clip", clipId: clip.id, start: layout.start, ...(target !== track ? { trackId: target.id } : {}) };
        label = target !== track ? "Chuyển track" : "Di chuyển clip";
      }
      if (command) void dispatch(label, [command]).finally(() => setDrag(undefined));
      else setDrag(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const draggedAsset = () => project.assets.find((asset) => asset.id === assetDrag.assetId);

  /** The row being pointed at if it can play the asset, otherwise the first one that can. */
  const dropTrack = (event: DragEvent, asset: Asset): Track | undefined => {
    const stub = { id: "", assetId: asset.id, start: 0, sourceIn: 0, duration: 1, volume: 100 };
    const over = tracks.find((candidate) => candidate.id === trackIdAt(event.clientX, event.clientY));
    if (over && trackAccepts(over, stub, project.assets)) return over;
    return tracks.find((candidate) => trackAccepts(candidate, stub, project.assets));
  };

  const onDragOver = (event: DragEvent) => {
    const asset = draggedAsset();
    if (!asset || !event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const target = dropTrack(event, asset);
    // No track for this kind yet: one is made on drop, and the main row shows where it would land.
    const others = target?.clips ?? [];
    setGhost({ start: resolveMove(others, asset.durationFrames, frameAt(event.clientX), snapFor(undefined)), duration: asset.durationFrames, trackId: target?.id ?? mainTrackId });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const asset = draggedAsset();
    if (asset && ghost) {
      const target = dropTrack(event, asset);
      editor.addAsset(asset, ghost.start, target?.id);
    }
    setGhost(undefined);
  };

  const step = rulerStep(pxPerFrame, fps);
  const ticks: number[] = [];
  for (let frame = 0; frame <= contentFrames; frame += step) ticks.push(frame);

  // The top row is the track drawn last, as it looks on screen. Numbered only when a kind has several.
  const rows = [...tracks].reverse().map((track) => {
    const same = tracks.filter((candidate) => candidate.kind === track.kind);
    return { track, name: same.length > 1 ? `${TRACK_NAMES[track.kind]} ${same.indexOf(track) + 1}` : TRACK_NAMES[track.kind] };
  });

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
        <IconButton label="Thêm chữ tại playhead" shortcut="T" onClick={editor.addText}>
          <Type size={18} aria-hidden />
        </IconButton>
        <IconButton label="Thêm track video" onClick={() => editor.addTrack("video")}>
          <Clapperboard size={18} aria-hidden />
        </IconButton>
        <IconButton label="Thêm track âm thanh" onClick={() => editor.addTrack("audio")}>
          <Music size={18} aria-hidden />
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

      <AgentNotice />

      <div className={styles.body}>
        <div className={styles.labels}>
          <div className={styles.labelRuler} />
          {rows.map(({ track, name }) => (
            <Fragment key={track.id}>
              <TrackLabel track={track} name={name} removable={track.id !== mainTrackId} spaced={false} />
              {track.id === mainTrackId && <div className={`${styles.labelAudio} ${styles.labelAudioSpaced}`}>Tiếng</div>}
            </Fragment>
          ))}
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
              {rows.map(({ track }) => {
                // A clip being dragged shows in the row it would land in.
                const shown = [
                  ...track.clips.filter((clip) => !(drag && drag.clipId === clip.id && drag.trackId !== track.id)).map((clip) => ({ clip, owner: track })),
                  ...(drag && drag.trackId === track.id
                    ? tracks.flatMap((other) => (other.id === track.id ? [] : other.clips.filter((clip) => clip.id === drag.clipId).map((clip) => ({ clip, owner: other }))))
                    : []),
                ];
                const layoutOf = (clip: Clip): Layout => (drag?.clipId === clip.id ? drag.layout : clip);
                const agentNote = (clip: Clip) => (editor.agentClips.has(clip.id) ? ", agent vừa sửa" : "");
                const ghostHere = ghost?.trackId === track.id && <Ghost start={ghost.start} duration={ghost.duration} />;
                if (track.kind === "text") {
                  return (
                    <div key={track.id} data-track-id={track.id} className={styles.trackVideo}>
                      {shown.map(({ clip, owner }) => {
                        if (isMediaClip(clip)) return null;
                        return (
                          <ClipBlock
                            key={clip.id}
                            isButton
                            className={styles.clipText}
                            layout={layoutOf(clip)}
                            selected={clip.id === selectedId}
                            byAgent={editor.agentClips.has(clip.id)}
                            label={`Chữ: ${clip.text}, bắt đầu ${frameToTimecode(layoutOf(clip).start, fps)}${agentNote(clip)}`}
                            onPointerDown={(event) => startClipDrag(event, clip, owner)}
                            onClickKey={() => select(clip.id)}
                          >
                            <span data-edge="start" className={styles.handleStart} />
                            {editor.agentClips.has(clip.id) && <Bot className={styles.agentMark} size={14} aria-hidden />}
                            <span className={styles.clipName}>{clip.text}</span>
                            <span data-edge="end" className={styles.handleEnd} />
                          </ClipBlock>
                        );
                      })}
                      {ghostHere}
                    </div>
                  );
                }
                if (track.kind === "audio") {
                  return (
                    <div key={track.id} data-track-id={track.id} className={styles.trackAudio}>
                      {shown.map(({ clip, owner }) => {
                        if (!isMediaClip(clip)) return null;
                        const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
                        if (!asset) return null;
                        const assetPeaks = peaks.get(asset.id);
                        return (
                          <ClipBlock
                            key={clip.id}
                            isButton
                            className={styles.clipAudio}
                            layout={layoutOf(clip)}
                            selected={clip.id === selectedId}
                            byAgent={editor.agentClips.has(clip.id)}
                            label={`Âm thanh ${asset.name}, bắt đầu ${frameToTimecode(layoutOf(clip).start, fps)}${agentNote(clip)}`}
                            onPointerDown={(event) => startClipDrag(event, clip, owner)}
                            onClickKey={() => select(clip.id)}
                          >
                            <span data-edge="start" className={styles.handleStart} />
                            {assetPeaks && assetPeaks.length > 0 && <Waveform peaks={assetPeaks} sourceIn={clip.sourceIn} duration={clip.duration} seconds={framesToSeconds(clip.duration, fps)} />}
                            <span data-edge="end" className={styles.handleEnd} />
                          </ClipBlock>
                        );
                      })}
                      {ghostHere}
                    </div>
                  );
                }
                return (
                  <Fragment key={track.id}>
                    <div data-track-id={track.id} className={styles.trackVideo}>
                      {shown.map(({ clip, owner }) => {
                        if (!isMediaClip(clip)) return null;
                        const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
                        if (!asset) return null;
                        const layout = layoutOf(clip);
                        return (
                          <ClipBlock
                            key={clip.id}
                            isButton
                            className={styles.clipVideo}
                            layout={layout}
                            selected={clip.id === selectedId}
                            byAgent={editor.agentClips.has(clip.id)}
                            label={`${asset.name}, bắt đầu ${frameToTimecode(layout.start, fps)}, dài ${frameToTimecode(layout.duration, fps)}${clip.transitionIn ? ", có transition" : ""}${agentNote(clip)}`}
                            onPointerDown={(event) => startClipDrag(event, clip, owner)}
                            onClickKey={() => select(clip.id)}
                          >
                            <span data-edge="start" className={styles.handleStart} />
                            {clip.transitionIn && <Blend className={styles.transitionMark} size={14} aria-hidden />}
                            <img
                              className={styles.clipThumb}
                              src={urls.thumbnail(projectId, asset.id, clip.sourceIn)}
                              alt=""
                              loading="lazy"
                              draggable={false}
                            />
                            {editor.agentClips.has(clip.id) && <Bot className={styles.agentMark} size={14} aria-hidden />}
                            <span className={styles.clipName}>{asset.name}</span>
                            <span data-edge="end" className={styles.handleEnd} />
                          </ClipBlock>
                        );
                      })}
                      {ghostHere}
                    </div>
                    {track.id === mainTrackId && (
                      <div data-track-id={track.id} className={styles.trackAudio}>
                        {shown.map(({ clip, owner }) => {
                          if (!isMediaClip(clip)) return null;
                          const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
                          if (!asset) return null;
                          const assetPeaks = peaks.get(asset.id);
                          return (
                            <ClipBlock
                              key={clip.id}
                              className={styles.clipAudio}
                              layout={layoutOf(clip)}
                              selected={clip.id === selectedId}
                              byAgent={editor.agentClips.has(clip.id)}
                              onPointerDown={(event) => startClipDrag(event, clip, owner)}
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
                    )}
                  </Fragment>
                );
              })}
              {clips.length === 0 && !ghost && <p className={styles.empty}>Kéo video từ Thư viện vào đây, hoặc bấm dấu cộng cạnh video.</p>}
            </div>
            <Playhead scroller={scroller} />
          </div>
        </div>
      </div>
    </section>
  );
}
