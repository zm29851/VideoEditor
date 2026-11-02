import { ArrowLeft, Download, Keyboard, Redo2, Undo2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isMediaClip, type Asset, type Clip, type CommandInput, type MediaClip, type Project, type Track } from "../../../src/schema.ts";
import { api, ApiError, urls, type ActivityEntry, type AgentStatus, type Job, type ProjectEvent, type ProjectState } from "../api.ts";
import { Button, EmptyState, IconButton, Tabs, useToast } from "../ui/ui.tsx";
import { Activity } from "./Activity.tsx";
import { agentClipIds, unseenAgentEntries } from "./agentNotice.ts";
import { AgentStatusBadge } from "./AgentStatusBadge.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { Library } from "./Library.tsx";
import { Player } from "./player.ts";
import { Preview } from "./Preview.tsx";
import { Properties } from "./Properties.tsx";
import { runRebased } from "./rebase.ts";
import { ShortcutsDialog, useShortcuts } from "./Shortcuts.tsx";
import { Timeline } from "./Timeline.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { clipAt, freeTrackId, neighbourTrack, nearestFreeStart, timelineEnd } from "./timelineOps.ts";
import styles from "./Editor.module.css";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
export const MIN_PX_PER_FRAME = 0.01;
export const MAX_PX_PER_FRAME = 16;
const ZOOM_STEP = 1.5;
const NEW_TEXT_SECONDS = 3;

export interface EditorContextValue {
  projectId: string;
  project: Project;
  /** Every clip on every track. */
  clips: Clip[];
  /** The first video track's clips, where speech is read from. */
  mainClips: MediaClip[];
  tracks: Track[];
  trackId: string;
  player: Player;
  jobs: Job[];
  selectedId: string | undefined;
  select: (clipId: string | undefined) => void;
  dispatch: (label: string, commands: CommandInput[] | ((latest: Project) => CommandInput[])) => Promise<ProjectState & { createdClipIds: string[] } | undefined>;
  addAsset: (asset: Asset, start?: number, trackId?: string) => void;
  addText: () => void;
  addTrack: (kind: Track["kind"]) => void;
  moveToTrack: (direction: 1 | -1) => void;
  cut: () => void;
  remove: (ripple: boolean) => void;
  trimToPlayhead: (edge: "start" | "end") => void;
  extendClip: (edge: "start" | "end") => void;
  nudge: (delta: number) => void;
  undo: () => void;
  redo: () => void;
  activity: ActivityEntry[];
  unseenAgent: ActivityEntry[];
  agentClips: Set<string>;
  revertBatch: (entry: ActivityEntry) => void;
  revertLatestAgentBatch: () => void;
  markAgentSeen: () => void;
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

function seenKey(projectId: string): string {
  return `ve:agent-seen:${projectId}`;
}

/** Only a convenience: without storage, the notice simply starts from what is on screen. */
function readSeen(projectId: string): number | undefined {
  try {
    const stored = localStorage.getItem(seenKey(projectId));
    return stored === null ? undefined : Number(stored);
  } catch {
    return undefined;
  }
}

function writeSeen(projectId: string, revision: number): void {
  try {
    localStorage.setItem(seenKey(projectId), String(revision));
  } catch {
    // The notice comes back on the next visit. Nothing else depends on it.
  }
}

export function Editor({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ProjectState>();
  const [loadError, setLoadError] = useState<ApiError>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agent, setAgent] = useState<AgentStatus>({ state: "offline" });
  const [connected, setConnected] = useState(true);
  const [seenRevision, setSeenRevision] = useState<number>();
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

  const apply = useCallback(
    (next: ProjectState) => {
      const current = stateRef.current;
      // A response and a push can arrive in either order. The state at one revision is always the same.
      if (current && next.project.revision <= current.project.revision) return;
      stateRef.current = next;
      setState(next);
      const clips = next.project.timeline.tracks.flatMap((track) => track.clips);
      player.setTimeline(next.project.timeline.tracks, next.project.assets, next.project.fps);
      setSelectedId((selected) => (clips.some((clip) => clip.id === selected) ? selected : undefined));
      if (!current) {
        const seen = readSeen(projectId);
        if (seen === undefined) writeSeen(projectId, next.project.revision);
        setSeenRevision(seen ?? next.project.revision);
      }
    },
    [player, projectId],
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

  // Edits by anyone, job progress and the agent's status all arrive here.
  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let delay = RECONNECT_MIN_MS;
    const connect = () => {
      socket = new WebSocket(urls.events(projectId));
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as ProjectEvent;
        switch (event.type) {
          case "snapshot":
            delay = RECONNECT_MIN_MS;
            setConnected(true);
            apply(event.state);
            setJobs(event.jobs);
            setAgent(event.agent);
            break;
          case "state":
            apply(event.state);
            break;
          case "job":
            setJobs((current) => [...current.filter((job) => job.id !== event.job.id), event.job]);
            break;
          case "agent":
            setAgent(event.agent);
            break;
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnected(false);
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [projectId, apply]);

  const send = useCallback(
    <T extends ProjectState>(call: (latest: Project) => Promise<T>, options: { label: string; rebase: boolean }): Promise<T | undefined> => {
      const work = queue.current.then(async () => {
        const outcome = await runRebased({
          attempt: async () => {
            const next = await call(stateRef.current!.project);
            apply(next);
            return next;
          },
          // Someone else got in first. Commands name clips, not positions in the list, so they still mean the same.
          refresh: async () => apply(await api.getProject(projectId)),
          isStale: (error) => error instanceof ApiError && error.code === "stale_revision",
          maxAttempts: options.rebase ? 3 : 1,
        });
        switch (outcome.kind) {
          case "done":
            return outcome.value;
          case "stale":
            toast(`Timeline vừa được thay đổi nên chưa thực hiện "${options.label}". Hãy kiểm tra rồi làm lại.`);
            return undefined;
          case "failed": {
            const message = outcome.error instanceof Error ? outcome.error.message : "Thao tác không thành công.";
            toast(outcome.rebased ? `Timeline vừa thay đổi nên không thể thực hiện "${options.label}": ${message}` : message);
            return undefined;
          }
        }
      });
      queue.current = work;
      return work;
    },
    [apply, projectId, toast],
  );

  const dispatch = useCallback<EditorContextValue["dispatch"]>(
    (label, commands) =>
      send(
        (latest) => api.batch(projectId, latest.revision, label, typeof commands === "function" ? commands(latest) : commands),
        { label, rebase: true },
      ),
    [projectId, send],
  );

  const markAgentSeen = useCallback(() => {
    const revision = stateRef.current?.project.revision;
    if (revision === undefined) return;
    writeSeen(projectId, revision);
    setSeenRevision(revision);
  }, [projectId]);

  const setPxPerFrame = useCallback((value: number) => {
    setPxPerFrameState(Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, value)));
  }, []);

  useEffect(() => {
    if (state) document.title = `${state.project.name} · Video Editor`;
  }, [state?.project.name]);

  const value = useMemo<EditorContextValue | null>(() => {
    if (!state) return null;
    const { project } = state;
    const tracks = project.timeline.tracks;
    const track = tracks.find((candidate) => candidate.kind === "video")!;
    const clips = tracks.flatMap((candidate) => candidate.clips);
    const mainClips = track.clips.filter(isMediaClip);
    const unseenAgent = unseenAgentEntries(state.activity, seenRevision ?? project.revision);
    const revertBatch = (entry: ActivityEntry) =>
      void send((latest) => api.revert(projectId, latest.revision, entry.revision), { label: `Hoàn tác lô: ${entry.label}`, rebase: true });

    /** The selected clip if the playhead is on it, otherwise whichever clip the playhead is on. */
    const clipUnderPlayhead = (): Clip | undefined => {
      const selected = clips.find((clip) => clip.id === selectedId);
      if (selected && clipAt([selected], player.frame)) return selected;
      return clipAt(mainClips, player.frame) ?? clipAt(clips, player.frame);
    };

    return {
      projectId,
      project,
      clips,
      mainClips,
      tracks,
      trackId: track.id,
      player,
      jobs,
      selectedId,
      select: setSelectedId,
      dispatch,
      addAsset: (asset, start, trackId) => {
        // Worked out from the latest timeline, because the agent may have filled this spot in the meantime.
        void dispatch(`Thêm ${asset.name}`, (latest) => {
          const kind: Track["kind"] = asset.hasVideo ? "video" : "audio";
          const target = latest.timeline.tracks.find((candidate) => candidate.id === trackId) ?? latest.timeline.tracks.find((candidate) => candidate.kind === kind);
          const id = target?.id ?? freeTrackId(latest, kind);
          const others = target?.clips ?? [];
          const position = nearestFreeStart(others, start ?? timelineEnd(others), asset.durationFrames);
          return [
            ...(target ? [] : [{ type: "add_track" as const, kind, id }]),
            { type: "add_clip" as const, trackId: id, assetId: asset.id, start: position, duration: asset.durationFrames },
          ];
        }).then((result) => setSelectedId(result?.createdClipIds[0]));
      },
      addText: () => {
        const frame = player.frame;
        const seconds = Math.round((NEW_TEXT_SECONDS * project.fps.num) / project.fps.den);
        void dispatch("Thêm chữ", (latest) => {
          const target = latest.timeline.tracks.find((candidate) => candidate.kind === "text");
          const id = target?.id ?? freeTrackId(latest, "text");
          const others = target?.clips ?? [];
          return [
            ...(target ? [] : [{ type: "add_track" as const, kind: "text" as const, id }]),
            { type: "add_text" as const, trackId: id, start: nearestFreeStart(others, frame, seconds), duration: seconds, text: "Chữ mới" },
          ];
        }).then((result) => setSelectedId(result?.createdClipIds[0]));
      },
      addTrack: (kind) => {
        void dispatch("Thêm track", (latest) => [{ type: "add_track", kind, id: freeTrackId(latest, kind) }]);
      },
      moveToTrack: (direction) => {
        const clip = clips.find((candidate) => candidate.id === selectedId);
        if (!clip) {
          toast("Hãy chọn một clip để chuyển track.");
          return;
        }
        const target = neighbourTrack(tracks, clip, direction, project.assets);
        if (!target) {
          toast("Không còn track nào phát được clip này ở hướng đó.");
          return;
        }
        void dispatch("Chuyển track", [{ type: "move_clip", clipId: clip.id, trackId: target.id, start: nearestFreeStart(target.clips, clip.start, clip.duration) }]);
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
      extendClip: (edge) => {
        const clip = clips.find((candidate) => candidate.id === selectedId);
        if (!clip) {
          toast("Hãy chọn một clip để kéo dài.");
          return;
        }
        const owner = tracks.find((candidate) => candidate.clips.includes(clip));
        const alsoTrackIds = owner?.id === track.id ? tracks.filter((candidate) => candidate.kind === "text").map((candidate) => candidate.id) : [];
        void dispatch(`Kéo dài ${edge === "start" ? "đầu" : "cuối"} clip`, [{ type: "trim_clip", clipId: clip.id, edge, delta: edge === "start" ? -1 : 1, ripple: true, alsoTrackIds }]);
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
      // Never resent: after someone else's edit, the same button would take back a different change.
      undo: () => void send((latest) => api.undo(projectId, latest.revision), { label: "Hoàn tác", rebase: false }),
      redo: () => void send((latest) => api.redo(projectId, latest.revision), { label: "Làm lại", rebase: false }),
      activity: state.activity,
      unseenAgent,
      agentClips: agentClipIds(unseenAgent),
      revertBatch,
      revertLatestAgentBatch: () => {
        const entry = state.activity.find((candidate) => candidate.actor === "agent" && candidate.revertible);
        if (entry) revertBatch(entry);
        else toast("Không còn lô nào của agent để hoàn tác.");
      },
      markAgentSeen,
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
  }, [state, projectId, player, jobs, selectedId, dispatch, send, seenRevision, markAgentSeen, snap, pxPerFrame, setPxPerFrame, fitRequest, toast]);

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
          <AgentStatusBadge agent={agent} connected={connected} />
          <Button variant="primary" onClick={value.openExport} disabled={value.clips.length === 0}>
            <Download size={18} aria-hidden />
            {exportJob ? `Đang xuất ${exportJob.progress ?? 0}%` : "Xuất video"}
          </Button>
        </header>
        <main className={styles.workspace}>
          <section className={styles.panelLeft} aria-label="Thư viện và transcript">
            <Tabs
              label="Thông tin bên trái"
              defaultValue="library"
              tabs={[
                { value: "library", title: "Thư viện", content: <Library /> },
                { value: "transcript", title: "Transcript", content: <TranscriptPanel /> },
              ]}
            />
          </section>
          <Preview />
          <section className={styles.panelRight} aria-label="Thuộc tính và hoạt động">
            <Tabs
              label="Thông tin bên phải"
              defaultValue="properties"
              tabs={[
                { value: "properties", title: "Thuộc tính", content: <Properties /> },
                { value: "activity", title: "Hoạt động", content: <Activity /> },
              ]}
            />
          </section>
          <Timeline />
        </main>
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </EditorContext.Provider>
  );
}

