import { ArrowLeft, Download, Keyboard, Redo2, Undo2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Asset, Clip, CommandInput, Project } from "../../../src/schema.ts";
import { api, ApiError, type Job, type ProjectState } from "../api.ts";
import { Button, EmptyState, IconButton, useToast } from "../ui/ui.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { Library } from "./Library.tsx";
import { Player } from "./player.ts";
import { Preview } from "./Preview.tsx";
import { Properties } from "./Properties.tsx";
import { ShortcutsDialog, useShortcuts } from "./Shortcuts.tsx";
import { Timeline } from "./Timeline.tsx";
import { clipAt, nearestFreeStart, timelineEnd } from "./timelineOps.ts";
import styles from "./Editor.module.css";

const POLL_IDLE_MS = 3000;
const POLL_BUSY_MS = 1000;
export const MIN_PX_PER_FRAME = 0.01;
export const MAX_PX_PER_FRAME = 16;
const ZOOM_STEP = 1.5;

export interface EditorContextValue {
  projectId: string;
  project: Project;
  clips: Clip[];
  trackId: string;
  player: Player;
  jobs: Job[];
  refreshStatus: () => void;
  selectedId: string | undefined;
  select: (clipId: string | undefined) => void;
  dispatch: (label: string, commands: CommandInput[]) => Promise<ProjectState & { createdClipIds: string[] } | undefined>;
  addAsset: (asset: Asset, start?: number) => void;
  cut: () => void;
  remove: (ripple: boolean) => void;
  trimToPlayhead: (edge: "start" | "end") => void;
  nudge: (delta: number) => void;
  undo: () => void;
  redo: () => void;
  snap: boolean;
  toggleSnap: () => void;
  pxPerFrame: number;
  setPxPerFrame: (value: number) => void;
  zoom: (direction: 1 | -1) => void;
  fitRequest: number;
  zoomFit: () => void;
  openExport: () => void;
  openShortcuts: () => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  return useContext(EditorContext)!;
}

function fpsLabel(project: Project): string {
  const value = project.fps.num / project.fps.den;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} fps`;
}

export function Editor({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ProjectState>();
  const [loadError, setLoadError] = useState<ApiError>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [snap, setSnap] = useState(true);
  const [pxPerFrame, setPxPerFrameState] = useState(1);
  const [fitRequest, setFitRequest] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const toast = useToast();
  const player = useMemo(() => new Player(), []);
  const stateRef = useRef<ProjectState | undefined>(undefined);
  // Edits run one at a time, so holding a key never sends a stale revision.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pollNow = useRef<() => void>(() => {});

  const apply = useCallback(
    (next: ProjectState) => {
      stateRef.current = next;
      setState(next);
      const clips = next.project.timeline.tracks.flatMap((track) => track.clips);
      player.setTimeline(clips, next.project.fps);
    },
    [player],
  );

  useEffect(() => {
    let cancelled = false;
    api.getProject(projectId).then(
      (loaded) => {
        if (!cancelled) apply(loaded);
      },
      (error: ApiError) => {
        if (!cancelled) setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, apply]);

  useEffect(() => {
    player.onError = toast;
  }, [player, toast]);

  // Shows imports, exports and edits made by others until Phase 3 replaces this with WebSocket.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      clearTimeout(timer);
      let busy = false;
      try {
        const status = await api.status(projectId);
        if (stopped) return;
        setJobs(status.jobs);
        busy = status.jobs.some((job) => job.status === "queued" || job.status === "running");
        const current = stateRef.current;
        if (current && status.revision !== current.project.revision) {
          const latest = await api.getProject(projectId);
          if (!stopped && latest.project.revision >= (stateRef.current?.project.revision ?? 0)) apply(latest);
        }
      } catch {
        // The next attempt reports nothing new if the server is gone; edits show their own error.
      }
      if (!stopped) timer = setTimeout(poll, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    pollNow.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [projectId, apply]);

  const send = useCallback(
    <T extends ProjectState>(call: (revision: number) => Promise<T>): Promise<T | undefined> => {
      const work = queue.current.then(async () => {
        try {
          const next = await call(stateRef.current!.project.revision);
          apply(next);
          return next;
        } catch (error) {
          if (error instanceof ApiError && error.code === "stale_revision") {
            apply(await api.getProject(projectId));
            toast("Timeline vừa được thay đổi nên thao tác chưa áp dụng. Hãy kiểm tra rồi làm lại.");
          } else {
            toast(error instanceof Error ? error.message : "Thao tác không thành công.");
          }
          return undefined;
        }
      });
      queue.current = work;
      return work;
    },
    [apply, projectId, toast],
  );

  const dispatch = useCallback(
    (label: string, commands: CommandInput[]) => send((revision) => api.batch(projectId, revision, label, commands)),
    [projectId, send],
  );

  const setPxPerFrame = useCallback((value: number) => {
    setPxPerFrameState(Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, value)));
  }, []);

  useEffect(() => {
    if (state) document.title = `${state.project.name} · Video Editor`;
  }, [state?.project.name]);

  const value = useMemo<EditorContextValue | null>(() => {
    if (!state) return null;
    const { project } = state;
    const track = project.timeline.tracks[0]!;
    const clips = track.clips;

    /** The selected clip if the playhead is on it, otherwise whichever clip the playhead is on. */
    const clipUnderPlayhead = (): Clip | undefined => {
      const selected = clips.find((clip) => clip.id === selectedId);
      if (selected && clipAt([selected], player.frame)) return selected;
      return clipAt(clips, player.frame);
    };

    return {
      projectId,
      project,
      clips,
      trackId: track.id,
      player,
      jobs,
      refreshStatus: () => pollNow.current(),
      selectedId,
      select: setSelectedId,
      dispatch,
      addAsset: (asset, start) => {
        const desired = start ?? timelineEnd(clips);
        const position = nearestFreeStart(clips, desired, asset.durationFrames);
        void dispatch(`Thêm ${asset.name}`, [
          { type: "add_clip", trackId: track.id, assetId: asset.id, start: position, duration: asset.durationFrames },
        ]).then((result) => setSelectedId(result?.createdClipIds[0]));
      },
      cut: () => {
        const clip = clipUnderPlayhead();
        if (!clip || clip.start === player.frame) {
          toast("Hãy đưa playhead vào giữa một clip rồi cắt.");
          return;
        }
        void dispatch("Cắt clip", [{ type: "split_clip", clipId: clip.id, at: player.frame }]);
      },
      remove: (ripple) => {
        if (!selectedId) {
          toast("Hãy chọn một clip trước khi xóa.");
          return;
        }
        void dispatch(ripple ? "Xóa và dồn clip" : "Xóa clip", [{ type: "delete_clip", clipId: selectedId, ripple }]);
        setSelectedId(undefined);
      },
      trimToPlayhead: (edge) => {
        const clip = clipUnderPlayhead();
        if (!clip) {
          toast("Hãy đưa playhead vào một clip để cắt bớt đầu hoặc cuối.");
          return;
        }
        const delta = edge === "start" ? player.frame - clip.start : player.frame - (clip.start + clip.duration);
        if (delta === 0) return;
        void dispatch("Cắt bớt clip", [{ type: "trim_clip", clipId: clip.id, edge, delta }]);
      },
      nudge: (delta) => {
        const clip = clips.find((candidate) => candidate.id === selectedId);
        if (!clip) {
          toast("Hãy chọn một clip để di chuyển.");
          return;
        }
        const start = Math.max(0, clip.start + delta);
        if (start !== clip.start) void dispatch("Di chuyển clip", [{ type: "move_clip", clipId: clip.id, start }]);
      },
      undo: () => void send((revision) => api.undo(projectId, revision)),
      redo: () => void send((revision) => api.redo(projectId, revision)),
      snap,
      toggleSnap: () => setSnap((current) => !current),
      pxPerFrame,
      setPxPerFrame,
      zoom: (direction) => setPxPerFrame(pxPerFrame * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      fitRequest,
      zoomFit: () => setFitRequest((request) => request + 1),
      openExport: () => setExportOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
    };
  }, [state, projectId, player, jobs, selectedId, dispatch, send, snap, pxPerFrame, setPxPerFrame, fitRequest, toast]);

  useShortcuts(value);

  if (loadError) {
    return (
      <main className={styles.centered}>
        <EmptyState title={loadError.status === 401 ? "Chưa có quyền truy cập" : "Không mở được project"}>
          <p>
            {loadError.status === 401
              ? "Hãy mở đường dẫn có token mà server in ra khi chạy lệnh npm start."
              : loadError.message}
          </p>
          <a href="#/">Về danh sách project</a>
        </EmptyState>
      </main>
    );
  }
  if (!value || !state) {
    return (
      <main className={styles.centered}>
        <EmptyState title="Đang mở project..." />
      </main>
    );
  }

  const { project } = value;
  const exportJob = [...jobs].reverse().find((job) => job.type === "export" && (job.status === "queued" || job.status === "running"));

  return (
    <EditorContext.Provider value={value}>
      <div className={styles.editor}>
        <header className={styles.topBar}>
          <a className={styles.back} href="#/" aria-label="Về danh sách project">
            <ArrowLeft size={18} aria-hidden />
          </a>
          <h1 className={styles.projectName}>{project.name}</h1>
          <span className={styles.spec}>
            {project.width} × {project.height} · {fpsLabel(project)}
          </span>
          <div className={styles.topActions}>
            <IconButton label={state.undoLabel ? `Hoàn tác: ${state.undoLabel}` : "Hoàn tác"} shortcut="⌘Z" onClick={value.undo} disabled={!state.undoLabel}>
              <Undo2 size={18} aria-hidden />
            </IconButton>
            <IconButton label={state.redoLabel ? `Làm lại: ${state.redoLabel}` : "Làm lại"} shortcut="⇧⌘Z" onClick={value.redo} disabled={!state.redoLabel}>
              <Redo2 size={18} aria-hidden />
            </IconButton>
            <IconButton label="Phím tắt" shortcut="?" onClick={value.openShortcuts}>
              <Keyboard size={18} aria-hidden />
            </IconButton>
          </div>
          <div className={styles.grow} />
          <Button variant="primary" onClick={value.openExport} disabled={value.clips.length === 0}>
            <Download size={18} aria-hidden />
            {exportJob ? `Đang xuất ${exportJob.progress ?? 0}%` : "Xuất video"}
          </Button>
        </header>
        <main className={styles.workspace}>
          <Library />
          <Preview />
          <Properties />
          <Timeline />
        </main>
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </EditorContext.Provider>
  );
}

