import { Captions, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Asset, Transcript } from "../../../src/schema.ts";
import { frameToTimecode } from "../../../src/time.ts";
import { rangesForWords, subtitleCues, timelineTranscript, type TimelineSegment, type TimelineWord, type WordRef } from "../../../src/transcript.ts";
import { api, type Job } from "../api.ts";
import { Button, Digits, EmptyState, IconButton, ProgressBar, Select } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import { freeTrackId } from "./timelineOps.ts";
import styles from "./Editor.module.css";

const LANGUAGES = [
  { value: "vi", label: "Tiếng Việt" },
  { value: "en", label: "Tiếng Anh" },
  { value: "auto", label: "Tự nhận diện" },
];
const LABEL_WORDS = 6;

interface Selection {
  anchor: number;
  focus: number;
}

const WordList = memo(function WordList({
  segments,
  low,
  high,
  focusIndex,
  fpsLabel,
  onClick,
  onKeyDown,
}: {
  segments: TimelineSegment[];
  low: number;
  high: number;
  focusIndex: number;
  fpsLabel: (frame: number) => string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  let index = -1;
  return (
    <div className={styles.transcript}>
      {segments.map((segment) => (
        <div key={`${segment.clipId}-${segment.start}`} className={styles.transcriptLine}>
          <span className={styles.timecode}>
            <Digits value={fpsLabel(segment.start)} />
          </span>
          <div className={styles.transcriptWords}>
            {segment.words.map((word) => {
              index++;
              return (
                <button
                  key={`${word.start}-${word.sourceStart}`}
                  type="button"
                  className={styles.word}
                  data-index={index}
                  data-filler={word.filler}
                  title={word.filler ? "Có thể là từ thừa" : undefined}
                  aria-pressed={index >= low && index <= high}
                  tabIndex={index === focusIndex ? 0 : -1}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  {word.text}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
});

function MissingTranscript({ asset, job, failed, language }: { asset: Asset; job: Job | undefined; failed: Job | undefined; language: string }) {
  const { projectId } = useEditor();
  const [error, setError] = useState<string>();
  const start = async () => {
    setError(undefined);
    try {
      await api.startTranscribe(projectId, asset.id, language);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không tạo được transcript.");
    }
  };
  return (
    <div className={styles.transcriptAsset}>
      <span className={styles.ellipsis} title={asset.name}>{asset.name}</span>
      {job ? (
        <>
          <span className={styles.muted}>
            {job.status === "queued" ? "Đang chờ tới lượt" : (job.stage ?? "Đang xử lý")}
            {job.status === "running" && job.progress !== undefined ? ` · ${job.progress}%` : ""}
          </span>
          <ProgressBar value={job.progress} label={`Tiến độ tạo transcript ${asset.name}`} />
          <Button onClick={() => void api.cancelJob(projectId, job.id).catch((caught: Error) => setError(caught.message))}>Hủy</Button>
          {error && <p role="alert" className={styles.errorDetail}>{error}</p>}
        </>
      ) : (
        <Button onClick={() => void start()}>
          <Captions size={18} aria-hidden />
          Tạo transcript
        </Button>
      )}
      {!job && (error ?? failed?.error) && (
        <p role="alert" className={styles.errorDetail}>{error ?? failed?.error}</p>
      )}
    </div>
  );
}

export function TranscriptPanel() {
  const { project, projectId, mainClips: clips, jobs, player, dispatch } = useEditor();
  const [transcripts, setTranscripts] = useState<ReadonlyMap<string, Transcript>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [language, setLanguage] = useState("vi");
  const [selection, setSelection] = useState<Selection>();
  const [focusIndex, setFocusIndex] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const refocus = useRef<number | undefined>(undefined);

  const usedAssets = useMemo(() => {
    const used = new Set(clips.map((clip) => clip.assetId));
    return project.assets.filter((asset) => used.has(asset.id));
  }, [clips, project.assets]);
  const usedKey = usedAssets.map((asset) => asset.id).join();
  const finishedKey = jobs.filter((job) => job.type === "transcribe" && job.status === "succeeded").map((job) => job.id).join();

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    Promise.all(usedAssets.map((asset) => api.transcript(projectId, asset.id))).then(
      (results) => {
        if (cancelled) return;
        setTranscripts(new Map(results.flatMap(({ transcript }) => (transcript ? [[transcript.assetId, transcript] as const] : []))));
        setLoading(false);
      },
      (caught: Error) => {
        if (cancelled) return;
        setLoadError(caught.message);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // Reads again when the videos on the timeline change or a transcript has just been made.
  }, [projectId, usedKey, finishedKey]);

  const segments = useMemo(() => timelineTranscript(project, transcripts), [project, transcripts]);
  const words = useMemo<TimelineWord[]>(() => segments.flatMap((segment) => segment.words), [segments]);

  // A selection is a position in this list, which means nothing once the timeline has changed.
  useEffect(() => {
    setSelection(undefined);
    setFocusIndex((index) => Math.min(index, Math.max(0, words.length - 1)));
    if (refocus.current !== undefined) {
      const target = Math.min(refocus.current, words.length - 1);
      refocus.current = undefined;
      container.current?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus();
    }
  }, [words]);

  // Follows playback by touching one attribute, so a long transcript is not rendered again on every frame.
  useEffect(() => {
    let current = -1;
    const element = (index: number) => container.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    const update = () => {
      const { frame } = player;
      // Rounding can make two words share a frame. The later one is the word that has just begun.
      const next = words.findLastIndex((word) => frame >= word.start && frame < word.end);
      if (next === current) return;
      element(current)?.removeAttribute("data-current");
      current = next;
      const target = element(next);
      target?.setAttribute("data-current", "true");
      if (player.playing) target?.scrollIntoView({ block: "nearest" });
    };
    update();
    const stop = player.subscribe(update);
    return () => {
      stop();
      element(current)?.removeAttribute("data-current");
    };
  }, [player, words]);

  const low = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const high = selection ? Math.max(selection.anchor, selection.focus) : -1;

  const removeWords = useCallback((first: number, last: number) => {
    const chosen = words.slice(first, last + 1);
    const preview = chosen.slice(0, LABEL_WORDS).map((word) => word.text).join(" ");
    const refs: WordRef[] = chosen.map((word) => ({
      assetId: segments.find((segment) => segment.words.includes(word))!.assetId,
      sourceStart: word.sourceStart,
      sourceEnd: word.sourceEnd,
      timelineStart: word.start,
    }));
    refocus.current = first;
    // Worked out from the latest timeline, because the agent may have moved these words in the meantime.
    void dispatch(`Xóa lời: "${preview}${chosen.length > LABEL_WORDS ? "..." : ""}"`, (latest) => {
      const ranges = rangesForWords(latest, refs);
      if (ranges.length === 0) throw new Error("Đoạn đã chọn không còn trên timeline.");
      // Subtitles stay with the words they show. Music on its own track keeps playing through the cut.
      const main = latest.timeline.tracks.find((track) => track.kind === "video")!;
      const alsoTrackIds = latest.timeline.tracks.filter((track) => track.kind === "text").map((track) => track.id);
      return [{ type: "delete_ranges", trackId: main.id, alsoTrackIds, ranges, ripple: true }];
    });
  }, [dispatch, segments, words]);

  const onWordClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const index = Number(event.currentTarget.dataset.index);
      setFocusIndex(index);
      // Safari does not focus a button when it is clicked, and Delete needs the focus here.
      event.currentTarget.focus();
      if (event.shiftKey) {
        setSelection((current) => ({ anchor: current?.anchor ?? index, focus: index }));
        return;
      }
      setSelection({ anchor: index, focus: index });
      player.seek(words[index]!.start);
    },
    [player, words],
  );

  const onWordKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const index = Number(event.currentTarget.dataset.index);
      const move = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (move !== 0) {
        const next = Math.min(words.length - 1, Math.max(0, index + move));
        setFocusIndex(next);
        if (event.shiftKey) setSelection((current) => ({ anchor: current?.anchor ?? index, focus: next }));
        event.currentTarget.parentElement?.closest(`.${styles.transcript}`)?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        if (low < 0) removeWords(index, index);
        else removeWords(low, high);
      } else if (event.key === "Escape") {
        setSelection(undefined);
      } else {
        return;
      }
      // These keys belong to the transcript while a word has focus, not to the timeline.
      event.preventDefault();
      event.stopPropagation();
    },
    [high, low, removeWords, words.length],
  );

  const makeSubtitles = useCallback(() => {
    void dispatch("Tạo phụ đề", (latest) => {
      const cues = subtitleCues(timelineTranscript(latest, transcripts));
      if (cues.length === 0) throw new Error("Chưa có lời nói nào để tạo phụ đề.");
      const trackId = freeTrackId(latest, "text");
      return [
        { type: "add_track", kind: "text", id: trackId },
        ...cues.map((cue) => ({ type: "add_text" as const, trackId, start: cue.start, duration: cue.end - cue.start, text: cue.text })),
      ];
    });
  }, [dispatch, transcripts]);

  const fpsLabel = useCallback((frame: number) => frameToTimecode(frame, project.fps), [project.fps]);

  if (clips.length === 0) {
    return (
      <EmptyState title="Timeline đang trống">
        <p>Thêm video vào timeline để xem lời nói ở đây.</p>
      </EmptyState>
    );
  }
  if (loading) return <EmptyState title="Đang đọc transcript..." />;
  if (loadError) {
    return (
      <EmptyState title="Không đọc được transcript">
        <p role="alert" className={styles.errorText}>{loadError}</p>
      </EmptyState>
    );
  }

  const transcribeJobs = jobs.filter((job) => job.type === "transcribe");
  const missing = usedAssets.filter((asset) => asset.hasAudio && !transcripts.has(asset.id));
  const canStart = missing.some((asset) => !transcribeJobs.some((job) => job.assetId === asset.id && (job.status === "queued" || job.status === "running")));
  const nothingToRead = usedAssets.every((asset) => !asset.hasAudio);

  return (
    <div ref={container} className={styles.transcript}>
      {nothingToRead && (
        <EmptyState title="Các clip không có tiếng">
          <p>Transcript chỉ tạo được từ video có tiếng.</p>
        </EmptyState>
      )}
      {!nothingToRead && missing.length === 0 && words.length === 0 && (
        <EmptyState title="Không có lời nói">
          <p>Không nhận ra lời nói nào trong các clip đang có.</p>
        </EmptyState>
      )}
      {missing.length > 0 && (
        <div className={styles.transcriptMissing}>
          <p className={styles.muted}>Tạo transcript có thể mất khoảng bằng thời lượng video. Bạn vẫn dựng được trong lúc chờ.</p>
          {canStart && <Select label="Ngôn ngữ trong video" value={language} options={LANGUAGES} onChange={setLanguage} />}
          {missing.map((asset) => {
            const own = transcribeJobs.filter((job) => job.assetId === asset.id);
            return (
              <MissingTranscript
                key={asset.id}
                asset={asset}
                language={language}
                job={own.find((job) => job.status === "queued" || job.status === "running")}
                failed={own.filter((job) => job.status === "failed").at(-1)}
              />
            );
          })}
        </div>
      )}
      {words.length > 0 && (
        // Always there, so choosing a word does not push the text away from under the pointer.
        <div className={styles.transcriptSelection}>
          <span className={styles.muted}>{selection ? `Đã chọn ${high - low + 1} từ` : "Bấm một từ để chọn"}</span>
          <IconButton label="Xóa và dồn đoạn đã chọn" shortcut="Delete" disabled={!selection} onClick={() => removeWords(low, high)}>
            <Trash2 size={18} aria-hidden />
          </IconButton>
        </div>
      )}
      {words.length > 0 && (
        <Button onClick={makeSubtitles}>
          <Captions size={18} aria-hidden />
          Tạo phụ đề trên track chữ mới
        </Button>
      )}
      <WordList segments={segments} low={low} high={high} focusIndex={focusIndex} fpsLabel={fpsLabel} onClick={onWordClick} onKeyDown={onWordKeyDown} />
    </div>
  );
}
