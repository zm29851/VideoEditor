import { Diamond } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_TRANSFORM, trackEnvelopes, valueAt } from "../../../src/animation.ts";
import { isMediaClip, type AnimatedProperty, type Clip, type CommandInput, type TextClip, type TextStyle } from "../../../src/schema.ts";
import { frameToTimecode } from "../../../src/time.ts";
import { Digits, EmptyState, IconButton, Select, Slider } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import styles from "./Editor.module.css";

const CANVASES = [
  { value: "1920x1080", label: "Ngang 16:9, 1920 × 1080" },
  { value: "1080x1920", label: "Dọc 9:16, 1080 × 1920" },
  { value: "1080x1080", label: "Vuông 1:1, 1080 × 1080" },
  { value: "1080x1350", label: "Dọc 4:5, 1080 × 1350" },
];

const TRANSITIONS = [
  { value: "none", label: "Không có" },
  { value: "crossfade", label: "Hòa tan" },
  { value: "dip", label: "Mờ qua đen" },
];

const FITS = [
  { value: "contain", label: "Vừa khung" },
  { value: "cover", label: "Lấp đầy khung" },
];

function CanvasPicker() {
  const { project, dispatch } = useEditor();
  const current = `${project.width}x${project.height}`;
  const options = CANVASES.some((option) => option.value === current)
    ? CANVASES
    : [{ value: current, label: `${project.width} × ${project.height}` }, ...CANVASES];
  return (
    <div className={styles.propertyGroup}>
      <h3 className={styles.groupTitle}>Khung hình của video</h3>
      <Select
        label="Khung hình của video"
        value={current}
        options={options}
        onChange={(value) => {
          const [width, height] = value.split("x").map(Number);
          void dispatch("Đổi khung hình", [{ type: "set_canvas", width: width!, height: height! }]);
        }}
      />
    </div>
  );
}

/** A slider for something keyframes can change. It shows the value at the playhead and edits there too. */
function AnimatedSlider({
  clip,
  property,
  label,
  fallback,
  min,
  max,
  step,
  scale,
  unit,
  setFixed,
}: {
  clip: Clip;
  property: AnimatedProperty;
  label: string;
  fallback: number;
  min: number;
  max: number;
  step: number;
  /** Shown value is the stored value times this. */
  scale: number;
  unit: string;
  setFixed: (value: number) => CommandInput;
}) {
  const { player, dispatch } = useEditor();
  const keys = clip.keyframes?.[property] ?? [];
  // Follows the playhead only when it matters, so a plain slider does not render on every frame.
  const frame = useSyncExternalStore(player.subscribe, () => (keys.length > 0 ? player.frame : clip.start));
  const canKey = useSyncExternalStore(player.subscribe, () => player.frame >= clip.start && player.frame < clip.start + clip.duration);
  const inside = Math.min(clip.duration - 1, Math.max(0, frame - clip.start));
  const stored = valueAt(keys, inside, fallback);
  const [draft, setDraft] = useState<number>();
  useEffect(() => setDraft(undefined), [stored]);
  const shown = draft ?? Math.round(stored * scale * 100) / 100;
  const playheadInside = () => {
    const position = player.frame - clip.start;
    return position >= 0 && position < clip.duration ? position : undefined;
  };
  const here = keys.some((key) => key.frame === inside);
  const writeKeys = (next: Array<{ frame: number; value: number }>, text: string) =>
    void dispatch(text, [{ type: "set_keyframes", clipId: clip.id, property, keyframes: next }]);

  return (
    <div className={styles.animated}>
      <span className={styles.volumeLabel}>
        {label} <output><Digits value={`${shown}${unit}`} /></output>
      </span>
      <IconButton
        label={canKey ? (here ? `Bỏ keyframe ${label} tại playhead` : `Đặt keyframe ${label} tại playhead`) : "Đưa playhead vào clip này để đặt keyframe"}
        pressed={here}
        disabled={!canKey}
        className={here ? styles.keyframeOn : undefined}
        onClick={() => {
          const position = playheadInside();
          if (position === undefined) return;
          if (keys.some((key) => key.frame === position)) writeKeys(keys.filter((key) => key.frame !== position), "Bỏ keyframe");
          else writeKeys([...keys, { frame: position, value: stored }], "Đặt keyframe");
        }}
      >
        <Diamond size={16} aria-hidden />
      </IconButton>
      <Slider
        label={label}
        value={shown}
        min={min}
        max={max}
        step={step}
        onChange={setDraft}
        onCommit={(next) => {
          const value = next / scale;
          if (keys.length === 0) {
            void dispatch(`Đổi ${label.toLowerCase()}`, [setFixed(value)]);
            return;
          }
          const position = playheadInside() ?? inside;
          writeKeys([...keys.filter((key) => key.frame !== position), { frame: position, value }], "Đặt keyframe");
        }}
      />
    </div>
  );
}

function LookControls({ clip }: { clip: Clip }) {
  const { dispatch } = useEditor();
  const base = clip.transform ?? DEFAULT_TRANSFORM;
  const set = (values: { x?: number; y?: number; scale?: number; opacity?: number }): CommandInput => ({ type: "set_transform", clipId: clip.id, ...values });
  return (
    <div className={styles.propertyGroup}>
      <h3 className={styles.groupTitle}>Vị trí và kích thước</h3>
      {isMediaClip(clip) && (
        <Select
          label="Cách đặt hình vào khung"
          value={clip.fit ?? "contain"}
          options={FITS}
          onChange={(value) => void dispatch("Đổi cách đặt hình", [{ type: "set_transform", clipId: clip.id, fit: value as "contain" | "cover" }])}
        />
      )}
      <AnimatedSlider clip={clip} property="x" label="Ngang" fallback={base.x} min={-100} max={100} step={1} scale={100} unit="%" setFixed={(x) => set({ x })} />
      <AnimatedSlider clip={clip} property="y" label="Dọc" fallback={base.y} min={-100} max={100} step={1} scale={100} unit="%" setFixed={(y) => set({ y })} />
      <AnimatedSlider clip={clip} property="scale" label="Thu phóng" fallback={base.scale} min={10} max={400} step={1} scale={100} unit="%" setFixed={(scale) => set({ scale })} />
      <AnimatedSlider clip={clip} property="opacity" label="Độ rõ" fallback={base.opacity} min={0} max={100} step={1} scale={100} unit="%" setFixed={(opacity) => set({ opacity })} />
    </div>
  );
}

function TransitionControls({ clip }: { clip: Clip }) {
  const { project, tracks, dispatch } = useEditor();
  const secondFrames = Math.round(project.fps.num / project.fps.den);
  const transition = clip.transitionIn;
  const [duration, setDuration] = useState(transition?.duration ?? secondFrames / 2);
  useEffect(() => {
    if (transition) setDuration(transition.duration);
  }, [transition?.duration]);
  const track = tracks.find((candidate) => candidate.clips.some((other) => other.id === clip.id));
  const envelope = track && trackEnvelopes(track.clips, project.assets).get(clip.id);
  const write = (type: string, frames: number) =>
    void dispatch("Đổi transition", [
      { type: "set_transition", clipId: clip.id, transition: type === "none" ? null : { type: type as "crossfade" | "dip", duration: Math.min(frames, clip.duration) } },
    ]);
  return (
    <div className={styles.propertyGroup}>
      <h3 className={styles.groupTitle}>Chuyển cảnh từ clip trước</h3>
      <Select label="Transition" value={transition?.type ?? "none"} options={TRANSITIONS} onChange={(value) => write(value, duration)} />
      {transition && (
        <div className={styles.volume}>
          <span className={styles.volumeLabel}>
            Độ dài <output><Digits value={`${duration} frame`} /></output>
          </span>
          <Slider label="Độ dài transition" value={duration} min={1} max={Math.min(clip.duration, secondFrames * 3)} onChange={setDuration} onCommit={(next) => write(transition.type, next)} />
          {transition.type === "crossfade" && !envelope?.tail && <p className={styles.muted}>Clip trước không liền kề hoặc đã hết đoạn dư nên clip này chỉ hiện dần.</p>}
          {envelope?.tail && envelope.tail.frames < transition.duration && <p className={styles.muted}>Clip trước chỉ còn đoạn dư {envelope.tail.frames} frame nên hòa tan ngắn hơn.</p>}
        </div>
      )}
    </div>
  );
}

function TextControls({ clip }: { clip: TextClip }) {
  const { dispatch } = useEditor();
  const [text, setText] = useState(clip.text);
  const [fontSize, setFontSize] = useState(clip.style.fontSize);
  useEffect(() => setText(clip.text), [clip.id, clip.text]);
  useEffect(() => setFontSize(clip.style.fontSize), [clip.id, clip.style.fontSize]);
  const setStyle = (label: string, style: Partial<TextStyle>) => void dispatch(label, [{ type: "set_text", clipId: clip.id, style }]);
  return (
    <div className={styles.propertyGroup}>
      <label className={styles.field}>
        <span>Nội dung</span>
        <textarea
          className={styles.textInput}
          value={text}
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const next = text.trim();
            if (next && next !== clip.text) void dispatch("Sửa chữ", [{ type: "set_text", clipId: clip.id, text: next }]);
            else setText(clip.text);
          }}
        />
      </label>
      <div className={styles.volume}>
        <span className={styles.volumeLabel}>
          Cỡ chữ <output><Digits value={`${fontSize}%`} /></output>
        </span>
        <Slider label="Cỡ chữ" value={fontSize} min={1} max={30} step={0.5} onChange={setFontSize} onCommit={(next) => setStyle("Đổi cỡ chữ", { fontSize: next })} />
      </div>
      <label className={styles.colorRow}>
        <span>Màu chữ</span>
        <input type="color" className={styles.colorInput} value={clip.style.color} onChange={(event) => setStyle("Đổi màu chữ", { color: event.target.value })} />
      </label>
      <label className={styles.colorRow}>
        <span>Có nền sau chữ</span>
        <input type="checkbox" checked={clip.style.background !== null} onChange={(event) => setStyle("Đổi nền chữ", { background: event.target.checked ? "#000000" : null })} />
      </label>
      {clip.style.background !== null && (
        <label className={styles.colorRow}>
          <span>Màu nền</span>
          <input type="color" className={styles.colorInput} value={clip.style.background} onChange={(event) => setStyle("Đổi nền chữ", { background: event.target.value })} />
        </label>
      )}
    </div>
  );
}

export function Properties() {
  const { clips, project, selectedId, dispatch } = useEditor();
  const clip = clips.find((candidate) => candidate.id === selectedId);
  if (!clip) {
    return (
      <>
        <CanvasPicker />
        <EmptyState title="Chưa chọn clip">
          <p>Chọn một clip trên timeline để xem chi tiết.</p>
        </EmptyState>
      </>
    );
  }
  const asset = isMediaClip(clip) ? project.assets.find((candidate) => candidate.id === clip.assetId) : undefined;
  const hasPicture = !isMediaClip(clip) || asset?.hasVideo === true;

  return (
    <>
      <div>
        <p className={styles.clipName} title={asset?.name ?? "Chữ"}>{asset?.name ?? "Chữ"}</p>
        <p className={styles.muted}>{clip.id}</p>
      </div>
      {!isMediaClip(clip) && <TextControls clip={clip} />}
      <dl className={styles.facts}>
        <div>
          <dt>Vị trí bắt đầu</dt>
          <dd>{frameToTimecode(clip.start, project.fps)}</dd>
        </div>
        <div>
          <dt>Độ dài</dt>
          <dd>{frameToTimecode(clip.duration, project.fps)}</dd>
        </div>
        {isMediaClip(clip) && (
          <div>
            <dt>Điểm vào nguồn</dt>
            <dd>{frameToTimecode(clip.sourceIn, project.fps)}</dd>
          </div>
        )}
        <div>
          <dt>Số frame</dt>
          <dd>{clip.duration}</dd>
        </div>
      </dl>
      {isMediaClip(clip) &&
        (asset?.hasAudio ? (
          <div className={styles.propertyGroup}>
            <AnimatedSlider
              clip={clip}
              property="volume"
              label="Âm lượng"
              fallback={clip.volume}
              min={0}
              max={200}
              step={1}
              scale={1}
              unit="%"
              setFixed={(volume) => ({ type: "set_volume", clipId: clip.id, volume })}
            />
          </div>
        ) : (
          <p className={styles.muted}>Video này không có tiếng.</p>
        ))}
      {hasPicture && <LookControls clip={clip} />}
      <TransitionControls clip={clip} />
    </>
  );
}
