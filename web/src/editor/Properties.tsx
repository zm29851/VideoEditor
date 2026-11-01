import { useEffect, useState } from "react";
import { frameToTimecode } from "../../../src/time.ts";
import { Digits, EmptyState, Slider } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import styles from "./Editor.module.css";

export function Properties() {
  const { clips, project, selectedId, dispatch } = useEditor();
  const clip = clips.find((candidate) => candidate.id === selectedId);
  const asset = project.assets.find((candidate) => candidate.id === clip?.assetId);
  const [volume, setVolume] = useState(clip?.volume ?? 100);

  useEffect(() => {
    if (clip) setVolume(clip.volume);
  }, [clip?.id, clip?.volume]);

  return (
    <section className={styles.panelRight} aria-label="Thuộc tính">
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Thuộc tính</h2>
      </div>
      <div className={styles.panelBody}>
        {!clip || !asset ? (
          <EmptyState title="Chưa chọn clip">
            <p>Chọn một clip trên timeline để xem chi tiết.</p>
          </EmptyState>
        ) : (
          <>
            <div>
              <p className={styles.clipName} title={asset.name}>{asset.name}</p>
              <p className={styles.muted}>{clip.id}</p>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>Vị trí bắt đầu</dt>
                <dd>{frameToTimecode(clip.start, project.fps)}</dd>
              </div>
              <div>
                <dt>Độ dài</dt>
                <dd>{frameToTimecode(clip.duration, project.fps)}</dd>
              </div>
              <div>
                <dt>Điểm vào nguồn</dt>
                <dd>{frameToTimecode(clip.sourceIn, project.fps)}</dd>
              </div>
              <div>
                <dt>Số frame</dt>
                <dd>{clip.duration}</dd>
              </div>
            </dl>
            {asset.hasAudio ? (
              <div className={styles.volume}>
                <span className={styles.volumeLabel}>
                  Âm lượng <output><Digits value={`${volume}%`} /></output>
                </span>
                <Slider
                  label="Âm lượng"
                  value={volume}
                  min={0}
                  max={200}
                  onChange={setVolume}
                  onCommit={(next) => {
                    if (next !== clip.volume) {
                      void dispatch("Đổi âm lượng", [{ type: "set_volume", clipId: clip.id, volume: next }]);
                    }
                  }}
                />
              </div>
            ) : (
              <p className={styles.muted}>Video này không có tiếng.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
