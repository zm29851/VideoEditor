import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandEngine } from "../src/engine.ts";
import { exportProject } from "../src/media/export.ts";
import { ffmpeg } from "../src/media/ffmpeg.ts";
import { hdrToSdrPixel } from "../src/media/hdr.ts";
import { importVideo } from "../src/media/import.ts";
import { probeMedia } from "../src/media/probe.ts";
import type { Asset, CommandInput, FrameRate } from "../src/schema.ts";
import { createProjectFolder } from "../src/store.ts";
import { findBeepStarts, makeSource, readBarcodes, readPcm, sampleFrameGray } from "./helpers.ts";

const FPS_30: FrameRate = { num: 30, den: 1 };
const TEST_SIZE = { width: 320, height: 180 };
const ONE_FRAME = 1 / 30;

let work: string;
let projectCounter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ve-media-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function newProject(fps: FrameRate = FPS_30, size = TEST_SIZE): { root: string; engine: CommandEngine } {
  const root = join(work, `project-${++projectCounter}`);
  return { root, engine: createProjectFolder(root, { name: "t", fps, ...size }) };
}

async function addAsset(root: string, engine: CommandEngine, source: string): Promise<Asset> {
  const { asset } = await importVideo(root, source, engine.project.fps);
  engine.registerAsset(asset);
  return asset;
}

function place(engine: CommandEngine, commands: CommandInput[]): void {
  engine.applyBatch({ actor: "user", baseRevision: engine.project.revision, label: "t", commands });
}

const add = (asset: Asset, start: number, sourceIn: number, duration: number): CommandInput => ({
  type: "add_clip",
  trackId: "video_1",
  assetId: asset.id,
  start,
  sourceIn,
  duration,
});

describe("Phase 0 acceptance: three cuts from 30 fps sources", () => {
  it("every frame comes from the expected source frame, and the sound stays in sync", async () => {
    const paths = [1, 2, 3].map((id) => join(work, `s30-${id}.mp4`));
    await Promise.all(paths.map((path, index) => makeSource(path, { sourceId: index + 1, fpsFilter: "30", seconds: 6 })));

    const { root, engine } = newProject();
    const [a, b, c] = [
      await addAsset(root, engine, paths[0]!),
      await addAsset(root, engine, paths[1]!),
      await addAsset(root, engine, paths[2]!),
    ] as [Asset, Asset, Asset];
    expect(a.normalization.transcoded).toBe(false);

    // Each clip starts on a whole second of its source, so each has a beep at known frames.
    const plan = [
      { asset: a, sourceId: 1, sourceIn: 30, duration: 45 },
      { asset: b, sourceId: 2, sourceIn: 60, duration: 25 },
      { asset: c, sourceId: 3, sourceIn: 0, duration: 61 },
    ];
    let cursor = 0;
    const commands = plan.map((clip) => {
      const command = add(clip.asset, cursor, clip.sourceIn, clip.duration);
      cursor += clip.duration;
      return command;
    });
    place(engine, commands);

    const output = join(work, "three-cuts.mp4");
    await exportProject(engine.project, output);

    const decoded = await readBarcodes(output);
    const expected = plan.flatMap((clip) =>
      Array.from({ length: clip.duration }, (_, index) => ({ sourceId: clip.sourceId, frame: clip.sourceIn + index })),
    );
    expect(decoded).toEqual(expected);

    const pcm = await readPcm(output);
    expect(Math.abs(pcm.length / 48000 - cursor / 30)).toBeLessThan(ONE_FRAME);

    // A beep starts every 30 source frames: clip 1 at 0 and 30, clip 2 at 45, clip 3 at 70, 100, 130.
    const expectedBeeps = [0, 30, 45, 70, 100, 130].map((frame) => frame / 30);
    const beeps = findBeepStarts(pcm);
    expect(beeps).toHaveLength(expectedBeeps.length);
    beeps.forEach((beep, index) => {
      expect(Math.abs(beep - expectedBeeps[index]!)).toBeLessThan(ONE_FRAME);
    });
  }, 180_000);
});

describe("mixed frame rates on a 30 fps timeline", () => {
  const cases = [
    { label: "24 fps", filter: "24", rate: 24 },
    { label: "29.97 fps", filter: "30000/1001", rate: 30000 / 1001 },
    { label: "60 fps", filter: "60", rate: 60 },
  ];

  for (const { label, filter, rate } of cases) {
    it(`${label}: normalises to exact frames that follow the source clock`, async () => {
      const source = join(work, `mixed-${rate.toFixed(2)}.mp4`);
      await makeSource(source, { sourceId: 5, fpsFilter: filter, seconds: 5 });

      const { root, engine } = newProject();
      const asset = await addAsset(root, engine, source);
      expect(asset.normalization.transcoded).toBe(true);
      expect(Math.abs(asset.durationFrames - 150)).toBeLessThanOrEqual(1);

      const master = await readBarcodes(asset.masterPath);
      master.forEach((decoded, index) => {
        const expectedSourceFrame = (index / 30) * rate;
        expect(Math.abs(decoded.frame - expectedSourceFrame)).toBeLessThanOrEqual(1);
      });

      const proxy = await readBarcodes(asset.proxyPath);
      expect(proxy).toEqual(master);

      place(engine, [add(asset, 0, 30, 60)]);
      const output = join(work, `mixed-${rate.toFixed(2)}-out.mp4`);
      await exportProject(engine.project, output);
      expect(await readBarcodes(output)).toEqual(master.slice(30, 90));
    }, 180_000);
  }

  it("all three together keep total length and sync", async () => {
    const sources = await Promise.all(
      cases.map(async ({ filter, rate }, index) => {
        const path = join(work, `all-${rate.toFixed(2)}.mp4`);
        await makeSource(path, { sourceId: index + 1, fpsFilter: filter, seconds: 4 });
        return path;
      }),
    );
    const { root, engine } = newProject();
    const assets: Asset[] = [];
    for (const source of sources) assets.push(await addAsset(root, engine, source));

    place(engine, assets.map((asset, index) => add(asset, index * 60, 30, 60)));
    const output = join(work, "all-out.mp4");
    await exportProject(engine.project, output);

    const decoded = await readBarcodes(output);
    expect(decoded).toHaveLength(180);
    expect(decoded.map((frame) => frame.sourceId)).toEqual([
      ...Array(60).fill(1),
      ...Array(60).fill(2),
      ...Array(60).fill(3),
    ]);

    const beeps = findBeepStarts(await readPcm(output));
    [0, 30, 60, 90, 120, 150].map((frame) => frame / 30).forEach((expected, index) => {
      expect(Math.abs(beeps[index]! - expected)).toBeLessThan(ONE_FRAME);
    });
    expect(beeps).toHaveLength(6);
  }, 240_000);
});

describe("iPhone-style inputs", () => {
  it("variable frame rate: is detected and becomes evenly timed", async () => {
    const source = join(work, "vfr.mp4");
    const constant = join(work, "vfr-base.mp4");
    await makeSource(constant, { sourceId: 1, fpsFilter: "30", seconds: 4 });
    // Slows the second half to half speed, so frame gaps change partway through.
    await ffmpeg([
      "-i",
      constant,
      "-vf",
      "setpts='if(lt(N,60),PTS,PTS+(N-60)/30/TB)'",
      "-fps_mode",
      "vfr",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-qp",
      "4",
      source,
    ]);
    const info = await probeMedia(source);
    expect(info.maxFrameJitter).toBeGreaterThan(0.2);

    const { root, engine } = newProject();
    const asset = await addAsset(root, engine, source);
    expect(asset.normalization.transcoded).toBe(true);

    const master = await probeMedia(asset.masterPath);
    expect(master.maxFrameJitter).toBeLessThan(0.05);
    expect(Math.abs(master.averageFps - 30)).toBeLessThan(0.01);
  }, 120_000);

  it("portrait rotation metadata: is applied and fits inside a landscape project", async () => {
    const stored = join(work, "landscape-stored.mp4");
    const rotated = join(work, "rotated.mov");
    await makeSource(stored, { sourceId: 2, fpsFilter: "30", seconds: 2, width: 640, height: 360 });
    await ffmpeg(["-display_rotation", "90", "-i", stored, "-c", "copy", rotated]);

    const { root, engine } = newProject(FPS_30, { width: 640, height: 360 });
    const asset = await addAsset(root, engine, rotated);
    expect([asset.width, asset.height]).toEqual([360, 640]);

    place(engine, [add(asset, 0, 0, 30)]);
    const output = join(work, "rotated-out.mp4");
    await exportProject(engine.project, output);

    const result = await probeMedia(output);
    expect([result.width, result.height, result.rotation]).toEqual([640, 360, 0]);
    // A rotated 360x640 frame scaled into 640x360 leaves black pillars at both sides.
    expect(await sampleFrameGray(output, "40:360:0:0")).toBeLessThan(24);
    expect(await sampleFrameGray(output, "40:360:600:0")).toBeLessThan(24);
    // The stored bottom half is flat gray and turns 90° counter-clockwise onto the right side;
    // the barcode of frame 0, mostly black, lands on the left.
    expect(await sampleFrameGray(output, "80:360:330:0")).toBeGreaterThan(100);
    expect(await sampleFrameGray(output, "80:360:230:0")).toBeLessThan(60);
  }, 120_000);

  it("HDR: HLG is tagged SDR with reference white near SDR white", async () => {
    const source = join(work, "hlg.mov");
    // A flat HLG signal of 0.75, the HLG reference white: 10-bit limited-range code 721.
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0xBFBFBF:s=320x180:r=30:d=2,format=yuv420p10le,geq=lum='721':cb='512':cr='512'",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
      "-pix_fmt",
      "yuv420p10le",
      source,
    ]);
    expect((await probeMedia(source)).isHdr).toBe(true);

    const { root, engine } = newProject();
    const asset = await addAsset(root, engine, source);
    expect(asset.normalization.wasHdr).toBe(true);

    const master = await probeMedia(asset.masterPath);
    expect(master.isHdr).toBe(false);
    expect(master.colorTransfer).toBe("bt709");
    expect(master.pixelFormat).toBe("yuv420p");

    // Limited-range 8-bit: black 16, white 235. Reference white must look bright, not blown out.
    const gray = await sampleFrameGray(asset.masterPath, "iw:ih:0:0");
    expect(gray).toBeGreaterThan(130);
    expect(gray).toBeLessThan(235);
  }, 120_000);

  it("HDR mapping curve keeps black and neutrals in order", () => {
    expect(hdrToSdrPixel("arib-std-b67", 0, 0, 0)).toEqual([0, 0, 0]);
    const levels = [0.25, 0.5, 0.75, 1].map((value) => hdrToSdrPixel("arib-std-b67", value, value, value)[1]);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    const [r, g, b] = hdrToSdrPixel("arib-std-b67", 0.5, 0.5, 0.5);
    expect(Math.abs(r - g)).toBeLessThan(0.02);
    expect(Math.abs(b - g)).toBeLessThan(0.02);
  });
});

describe("timeline features in export", () => {
  it("a gap becomes black and silence with the right length", async () => {
    const source = join(work, "gap.mp4");
    await makeSource(source, { sourceId: 1, fpsFilter: "30", seconds: 3 });
    const { root, engine } = newProject();
    const asset = await addAsset(root, engine, source);
    place(engine, [add(asset, 0, 0, 15), add(asset, 45, 30, 15)]);

    const output = join(work, "gap-out.mp4");
    await exportProject(engine.project, output);
    expect((await probeMedia(output)).frameCount).toBe(60);
    const beeps = findBeepStarts(await readPcm(output));
    expect(beeps).toHaveLength(2);
    expect(Math.abs(beeps[1]! - 45 / 30)).toBeLessThan(ONE_FRAME);
  }, 120_000);

  it("a source without audio exports with silence", async () => {
    const source = join(work, "silent.mp4");
    await makeSource(source, { sourceId: 1, fpsFilter: "30", seconds: 2, audio: false });
    const { root, engine } = newProject();
    const asset = await addAsset(root, engine, source);
    expect(asset.hasAudio).toBe(false);
    place(engine, [add(asset, 0, 0, 30)]);

    const output = join(work, "silent-out.mp4");
    await exportProject(engine.project, output);
    const pcm = await readPcm(output);
    expect(Math.abs(pcm.length / 48000 - 1)).toBeLessThan(ONE_FRAME);
    expect(pcm.every((sample) => sample === 0)).toBe(true);
  }, 120_000);

  it("volume changes the level, and a split exports the same frames as no split", async () => {
    const source = join(work, "volume.mp4");
    await makeSource(source, { sourceId: 1, fpsFilter: "30", seconds: 3 });

    const whole = newProject();
    const wholeAsset = await addAsset(whole.root, whole.engine, source);
    place(whole.engine, [{ ...add(wholeAsset, 0, 0, 60), volume: 50 } as CommandInput]);
    const wholeOut = join(work, "volume-whole.mp4");
    await exportProject(whole.engine.project, wholeOut);
    const peak = (await readPcm(wholeOut)).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.32);

    const cut = newProject();
    const cutAsset = await addAsset(cut.root, cut.engine, source);
    place(cut.engine, [add(cutAsset, 0, 0, 60)]);
    const clipId = cut.engine.project.timeline.tracks[0]!.clips[0]!.id;
    place(cut.engine, [{ type: "split_clip", clipId, at: 23 }]);
    const cutOut = join(work, "volume-cut.mp4");
    await exportProject(cut.engine.project, cutOut);
    expect(await readBarcodes(cutOut)).toEqual(await readBarcodes(wholeOut));
  }, 180_000);

  it("never modifies the original file", async () => {
    const source = join(work, "untouched.mp4");
    await makeSource(source, { sourceId: 1, fpsFilter: "24", seconds: 2 });
    const before = readFileSync(source);
    const modified = statSync(source).mtimeMs;
    const { root, engine } = newProject();
    await addAsset(root, engine, source);
    expect(readFileSync(source).equals(before)).toBe(true);
    expect(statSync(source).mtimeMs).toBe(modified);
  }, 60_000);
});
