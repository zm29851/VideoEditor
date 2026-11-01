import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import styles from "./Timeline.module.css";

/** One value per frame, so a clip takes exactly its own part of the source waveform. */
export function Waveform({ peaks, sourceIn, duration, seconds }: { peaks: number[]; sourceIn: number; duration: number; seconds: number }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // A canvas cannot read CSS variables, so the colour is resolved here.
    const color = getComputedStyle(element).getPropertyValue("--color-waveform").trim();
    const surfer = WaveSurfer.create({
      container: element,
      height: "auto",
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      interact: false,
      hideScrollbar: true,
      peaks: [peaks.slice(sourceIn, sourceIn + duration)],
      duration: seconds,
    });
    return () => surfer.destroy();
  }, [peaks, sourceIn, duration, seconds]);

  return <div ref={container} className={styles.waveform} />;
}
