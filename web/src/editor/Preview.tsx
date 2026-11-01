import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
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

export function Preview() {
  const { player, projectId, project, clips } = useEditor();
  const deckA = useRef<HTMLVideoElement>(null);
  const deckB = useRef<HTMLVideoElement>(null);
  const stage = useCssVars<HTMLDivElement>({ "--preview-aspect": project.width / project.height });

  useEffect(() => {
    player.attach(deckA.current!, deckB.current!, (assetId) => urls.proxy(projectId, assetId));
    return () => player.detach();
  }, [player, projectId]);

  return (
    <section className={styles.preview} aria-label="Xem trước">
      <div className={styles.stageArea}>
        <div ref={stage} className={styles.stage}>
          <video ref={deckA} className={styles.deck} playsInline preload="auto" data-visible="false" />
          <video ref={deckB} className={styles.deck} playsInline preload="auto" data-visible="false" />
          {clips.length === 0 && <p className={styles.stageEmpty}>Thêm video vào timeline để xem trước.</p>}
        </div>
      </div>
      <Transport />
    </section>
  );
}
