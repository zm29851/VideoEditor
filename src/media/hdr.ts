import { writeFileSync } from "node:fs";

const LUT_SIZE = 33;
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
const HLG_SYSTEM_GAMMA = 1.2;
const HLG_PEAK_NITS = 1000;
const PQ_PEAK_NITS = 10_000;
const SDR_WHITE_NITS = 203;

const hlgToLinear = (signal: number) =>
  signal <= 0.5 ? (signal * signal) / 3 : (Math.exp((signal - HLG_C) / HLG_A) + HLG_B) / 12;

function pqToLinear(signal: number): number {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const power = Math.pow(signal, 1 / m2);
  return Math.pow(Math.max(power - c1, 0) / (c2 - c3 * power), 1 / m1);
}

/** Extended Reinhard: leaves values up to SDR white nearly unchanged, rolls highlights off. */
function toneMap(relativeToWhite: number, peak: number): number {
  return (relativeToWhite * (1 + relativeToWhite / (peak * peak))) / (1 + relativeToWhite);
}

const linearToBt709 = (value: number) =>
  value < 0.018 ? 4.5 * value : 1.099 * Math.pow(value, 0.45) - 0.099;

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * Maps a BT.2020 HDR signal to SDR BT.709. This FFmpeg build has no zscale, and a LUT
 * gives the same result in software everywhere, so it is computed here.
 */
export function hdrToSdrPixel(transfer: string, r: number, g: number, b: number): [number, number, number] {
  let linear: [number, number, number];
  if (transfer === "smpte2084") {
    linear = [pqToLinear(r), pqToLinear(g), pqToLinear(b)].map(
      (value) => (value * PQ_PEAK_NITS) / SDR_WHITE_NITS,
    ) as [number, number, number];
  } else {
    const scene = [hlgToLinear(r), hlgToLinear(g), hlgToLinear(b)] as const;
    const luminance = 0.2627 * scene[0] + 0.678 * scene[1] + 0.0593 * scene[2];
    const ootf = Math.pow(Math.max(luminance, 1e-6), HLG_SYSTEM_GAMMA - 1);
    linear = scene.map((value) => (value * ootf * HLG_PEAK_NITS) / SDR_WHITE_NITS) as [number, number, number];
  }

  const peak = (transfer === "smpte2084" ? PQ_PEAK_NITS : HLG_PEAK_NITS) / SDR_WHITE_NITS;
  const luminance = 0.2627 * linear[0] + 0.678 * linear[1] + 0.0593 * linear[2];
  const scale = luminance > 0 ? toneMap(luminance, peak) / luminance : 0;
  const [mappedR, mappedG, mappedB] = linear.map((value) => value * scale) as [number, number, number];

  return [
    linearToBt709(clamp(1.6605 * mappedR - 0.5876 * mappedG - 0.0728 * mappedB)),
    linearToBt709(clamp(-0.1246 * mappedR + 1.1329 * mappedG - 0.0083 * mappedB)),
    linearToBt709(clamp(-0.0182 * mappedR - 0.1006 * mappedG + 1.1187 * mappedB)),
  ];
}

export function writeHdrLut(path: string, transfer: string): void {
  const lines = [`LUT_3D_SIZE ${LUT_SIZE}`];
  const last = LUT_SIZE - 1;
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const pixel = hdrToSdrPixel(transfer, r / last, g / last, b / last);
        lines.push(pixel.map((value) => value.toFixed(6)).join(" "));
      }
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}
