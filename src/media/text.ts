import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { isMediaClip, type Project, type TextClip, type TextStyle } from "../schema.ts";

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@fontsource", "be-vietnam-pro", "files");
const SUBSETS = ["vietnamese", "latin", "latin-ext"];
/** The font comes in one file per alphabet. Listing all of them lets each letter find its own. */
const FONT_LIST = SUBSETS.map((subset) => `"BVP-${subset}"`).join(",");
const MAX_WIDTH_SHARE = 0.9;
const LINE_HEIGHT = 1.3;

let fontsReady = false;

function loadFonts(): void {
  if (fontsReady) return;
  for (const subset of SUBSETS) {
    for (const weight of [400, 600]) {
      GlobalFonts.registerFromPath(join(FONT_DIR, `be-vietnam-pro-${subset}-${weight}-normal.woff2`), `BVP-${subset}`);
    }
  }
  fontsReady = true;
}

function wrap(context: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * A transparent PNG the size of the canvas with the text in the middle. This FFmpeg has no drawtext,
 * and the preview shows this same picture, so what is seen is what gets exported.
 */
export function renderTextImage(text: string, style: TextStyle, width: number, height: number): Buffer {
  loadFonts();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const size = (style.fontSize / 100) * height;
  context.font = `${style.weight} ${size}px ${FONT_LIST}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";

  const lines = wrap(context, text, width * MAX_WIDTH_SHARE);
  const lineHeight = size * LINE_HEIGHT;
  const top = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  if (style.background) {
    const padding = size * 0.35;
    const widest = Math.max(...lines.map((line) => context.measureText(line).width));
    context.fillStyle = style.background;
    context.fillRect(width / 2 - widest / 2 - padding, top - lineHeight / 2 - padding / 2, widest + padding * 2, lines.length * lineHeight + padding);
  }
  lines.forEach((line, index) => {
    const y = top + index * lineHeight;
    if (!style.background) {
      // An outline keeps the text readable over any picture.
      context.strokeStyle = "#000000";
      context.lineWidth = size * 0.12;
      context.strokeText(line, width / 2, y);
    }
    context.fillStyle = style.color;
    context.fillText(line, width / 2, y);
  });
  return canvas.toBuffer("image/png");
}

/** Stored by content, so editing a clip back to an earlier text finds its picture again. */
export function textImagePath(directory: string, clip: Pick<TextClip, "text" | "style">, width: number, height: number): string {
  const key = createHash("sha256").update(JSON.stringify([clip.text, clip.style, width, height])).digest("hex").slice(0, 24);
  const path = join(directory, `${key}.png`);
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${path}.tmp`, renderTextImage(clip.text, clip.style, width, height));
    renameSync(`${path}.tmp`, path);
  }
  return path;
}

export function textImagesFor(project: Project, directory: string): Map<string, string> {
  const images = new Map<string, string>();
  for (const clip of project.timeline.tracks.flatMap((track) => track.clips)) {
    if (!isMediaClip(clip)) images.set(clip.id, textImagePath(directory, clip, project.width, project.height));
  }
  return images;
}
