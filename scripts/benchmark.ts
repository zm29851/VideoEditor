/**
 * Measures import and export on real files. Originals are only read; everything else goes
 * into the output folder.
 *
 * node scripts/benchmark.ts <output folder> <video>...
 */
import { mkdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { exportProject } from "../src/media/export.ts";
import { createMaster, importVideo, normalizationReasons } from "../src/media/import.ts";
import { probeMedia } from "../src/media/probe.ts";
import { createProjectFolder } from "../src/store.ts";
import { AUDIO_SAMPLE_RATE, fpsToNumber } from "../src/time.ts";
import { ffmpeg, ffprobe } from "../src/media/ffmpeg.ts";

const [rawOutput, ...videos] = process.argv.slice(2);
if (!rawOutput || videos.length === 0) throw new Error("Cách dùng: benchmark <thư mục ra> <video>...");
const output = resolve(rawOutput);
mkdirSync(output, { recursive: true });

const megabytes = (path: string) => statSync(path).size / 1024 / 1024;
const fixed = (value: number) => Number(value.toFixed(2));

async function timed(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work();
  return (performance.now() - start) / 1000;
}

async function streamDuration(path: string, stream: string): Promise<number> {
  const { stdout } = await ffprobe(["-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", path]);
  return Number.parseFloat(stdout.toString());
}

for (const [index, rawVideo] of videos.entries()) {
  const video = resolve(rawVideo);
  const root = join(output, `project-${index}`);
  const info = await probeMedia(video);
  const landscape = info.width >= info.height;
  const engine = createProjectFolder(root, {
    name: basename(video),
    width: landscape ? 1920 : 1080,
    height: landscape ? 1080 : 1920,
  });
  const fps = engine.project.fps;

  const { asset, timings } = await importVideo(root, video, fps);
  engine.registerAsset(asset);
  const seconds = asset.durationFrames / fpsToNumber(fps);

  // Three cuts spread across the file, one third of a minute at most each.
  const length = Math.min(Math.floor(asset.durationFrames / 4), 300);
  const positions = [0, 0.4, 0.7].map((share) => Math.floor(asset.durationFrames * share));
  engine.applyBatch({
    actor: "user",
    baseRevision: engine.project.revision,
    label: "benchmark",
    commands: positions.map((sourceIn, cut) => ({
      type: "add_clip" as const,
      trackId: "video_1",
      assetId: asset.id,
      start: cut * length,
      sourceIn,
      duration: length,
    })),
  });

  const x264Out = join(output, `export-${index}-x264.mp4`);
  const x264Seconds = await timed(() => exportProject(engine.project, x264Out));
  const vtOut = join(output, `export-${index}-vt.mp4`);
  const vtSeconds = await timed(() => exportProject(engine.project, vtOut, { encoder: "h264_videotoolbox" }));

  // Forces a master for every file, to compare encoders even when import skipped it.
  const encoders = {} as Record<string, { seconds: number; megabytes: number; realtime: number }>;
  const excerptSeconds = Math.min(seconds, 60);
  const excerpt = join(output, `excerpt-${index}.mov`);
  await ffmpeg(["-t", String(excerptSeconds), "-i", video, "-c", "copy", excerpt]);
  const excerptInfo = await probeMedia(excerpt);
  for (const encoder of ["libx264", "h264_videotoolbox"] as const) {
    const path = join(output, `master-${index}-${encoder}.mp4`);
    const spent = await timed(() => createMaster(excerpt, path, excerptInfo, fps, join(root, "cache"), { encoder }));
    encoders[encoder] = {
      seconds: fixed(spent),
      megabytes: fixed(megabytes(path)),
      realtime: fixed(excerptSeconds / spent),
    };
  }

  const exported = await probeMedia(x264Out);
  console.log(
    JSON.stringify(
      {
        file: basename(video),
        source: {
          megabytes: fixed(megabytes(video)),
          codec: info.codec,
          size: `${info.width}x${info.height}`,
          rotation: info.rotation,
          averageFps: fixed(info.averageFps),
          maxFrameJitter: fixed(info.maxFrameJitter),
          hdr: info.isHdr,
          seconds: fixed(seconds),
        },
        reasons: normalizationReasons(info, fps),
        import: {
          masterSeconds: fixed(timings.masterSeconds),
          proxySeconds: fixed(timings.proxySeconds),
          masterMegabytes: fixed(asset.normalization.transcoded ? megabytes(asset.masterPath) : 0),
          proxyMegabytes: fixed(megabytes(asset.proxyPath)),
          frames: asset.durationFrames,
        },
        masterEncoders: encoders,
        export: {
          frameCountExpected: length * 3,
          frameCountActual: exported.frameCount,
          videoSeconds: fixed(await streamDuration(x264Out, "v:0")),
          audioSeconds: fixed(await streamDuration(x264Out, "a:0")),
          expectedSeconds: fixed((length * 3) / fpsToNumber(fps)),
          audioSampleRate: exported.audioSampleRate === AUDIO_SAMPLE_RATE,
          x264Seconds: fixed(x264Seconds),
          x264Megabytes: fixed(megabytes(x264Out)),
          videotoolboxSeconds: fixed(vtSeconds),
          videotoolboxMegabytes: fixed(megabytes(vtOut)),
        },
      },
      null,
      2,
    ),
  );
}
