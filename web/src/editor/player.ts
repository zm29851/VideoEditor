import type { Clip, FrameRate } from "../../../src/schema.ts";
import { clipAt, clipEnd, frameAtTime, seekTimeForFrame, timelineEnd } from "./timelineOps.ts";

/** How long before a cut the next clip is loaded and seeked, in seconds. */
const PREPARE_AHEAD = 2;
/** Switching a touch early means the frame after the cut point never reaches the screen. */
const SWITCH_MARGIN = 1 / 120;
/** Closer than this to a cut, a timer takes over: animation frames slow down when the machine is busy. */
const CUT_TIMER_WINDOW = 0.3;

interface Deck {
  video: HTMLVideoElement;
  assetId?: string;
  /** Asked for while the deck is busy. Only the latest position matters when scrubbing. */
  pendingTime?: number;
  seeking: boolean;
  gain?: GainNode;
}

export interface PlayerSnapshot {
  frame: number;
  playing: boolean;
}

/** Plays the timeline on two video elements. The hidden one waits at the next clip, so cuts are clean. */
export class Player {
  #decks: [Deck, Deck] | undefined;
  #active = 0;
  #clips: Clip[] = [];
  #fps: FrameRate = { num: 30, den: 1 };
  #proxyUrl: (assetId: string) => string = () => "";
  #frame = 0;
  #playing = false;
  #current: Clip | undefined;
  #raf = 0;
  #cutTimer: ReturnType<typeof setTimeout> | undefined;
  #gapClock: { startedAt: number; startFrame: number } | undefined;
  #audio: AudioContext | undefined;
  #listeners = new Set<() => void>();
  #snapshot: PlayerSnapshot = { frame: 0, playing: false };
  onError: ((message: string) => void) | undefined;

  attach(a: HTMLVideoElement, b: HTMLVideoElement, proxyUrl: (assetId: string) => string): void {
    this.#proxyUrl = proxyUrl;
    this.#decks = [this.#makeDeck(a), this.#makeDeck(b)];
    this.#active = 0;
    this.#showFrame();
  }

  detach(): void {
    this.pause();
    for (const deck of this.#decks ?? []) {
      deck.video.removeAttribute("src");
      deck.video.load();
    }
    this.#decks = undefined;
    void this.#audio?.close();
    this.#audio = undefined;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.#snapshot;

  get frame(): number {
    return this.#frame;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get duration(): number {
    return timelineEnd(this.#clips);
  }

  /** The clips changed. Playback stops so what is on screen always matches the new timeline. */
  setTimeline(clips: Clip[], fps: FrameRate): void {
    const unchanged = JSON.stringify(clips) === JSON.stringify(this.#clips);
    this.#clips = clips;
    this.#fps = fps;
    if (unchanged) return;
    this.pause();
    this.#frame = Math.min(this.#frame, this.duration);
    this.#showFrame();
    this.#emit();
  }

  seek(frame: number): void {
    this.pause();
    this.#frame = Math.max(0, Math.min(Math.round(frame), this.duration));
    this.#showFrame();
    this.#emit();
  }

  step(delta: number): void {
    this.seek(this.#frame + delta);
  }

  toggle(): void {
    if (this.#playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.#playing || !this.#decks || this.duration === 0) return;
    if (this.#frame >= this.duration) this.#frame = 0;
    this.#audio ??= new AudioContext();
    void this.#audio.resume();
    this.#playing = true;
    this.#enterFrame(this.#frame);
    this.#raf = requestAnimationFrame(this.#tick);
    this.#emit();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    cancelAnimationFrame(this.#raf);
    this.#clearCutTimer();
    this.#gapClock = undefined;
    for (const deck of this.#decks ?? []) deck.video.pause();
    this.#emit();
  }

  #makeDeck(video: HTMLVideoElement): Deck {
    const deck: Deck = { video, seeking: false };
    video.addEventListener("seeked", () => {
      deck.seeking = false;
      this.#flushSeek(deck);
    });
    video.addEventListener("loadedmetadata", () => this.#flushSeek(deck));
    video.addEventListener("error", () => {
      if (video.getAttribute("src")) {
        this.pause();
        this.onError?.("Không phát được bản xem trước của video này. Hãy thử import lại video.");
      }
    });
    return deck;
  }

  #flushSeek(deck: Deck): void {
    if (deck.pendingTime === undefined || deck.seeking || deck.video.readyState < 1) return;
    const time = deck.pendingTime;
    deck.pendingTime = undefined;
    deck.seeking = true;
    deck.video.currentTime = time;
  }

  #cue(deck: Deck, clip: Clip, sourceFrame: number): void {
    if (deck.assetId !== clip.assetId) {
      deck.assetId = clip.assetId;
      deck.seeking = false;
      deck.video.src = this.#proxyUrl(clip.assetId);
    }
    deck.pendingTime = seekTimeForFrame(sourceFrame, this.#fps);
    this.#flushSeek(deck);
  }

  #setVisible(deck: Deck | undefined): void {
    for (const candidate of this.#decks ?? []) {
      candidate.video.dataset.visible = String(candidate === deck);
    }
  }

  #applyVolume(deck: Deck, clip: Clip): void {
    if (this.#audio && !deck.gain) {
      deck.gain = this.#audio.createGain();
      this.#audio.createMediaElementSource(deck.video).connect(deck.gain).connect(this.#audio.destination);
    }
    // Same linear scale as the volume filter in export, and it can go above 100%.
    if (deck.gain) deck.gain.gain.value = clip.volume / 100;
  }

  /** Paused: put the right frame on screen, or black for a gap. */
  #showFrame(): void {
    if (!this.#decks) return;
    const clip = clipAt(this.#clips, this.#frame);
    this.#current = clip;
    const deck = this.#decks[this.#active]!;
    if (!clip) {
      this.#setVisible(undefined);
      return;
    }
    this.#setVisible(deck);
    this.#cue(deck, clip, clip.sourceIn + this.#frame - clip.start);
  }

  /** Playing: start whatever belongs at this frame, on the active deck. */
  #enterFrame(frame: number): void {
    const decks = this.#decks!;
    const clip = clipAt(this.#clips, frame);
    this.#current = clip;
    if (!clip) {
      this.#setVisible(undefined);
      this.#gapClock = { startedAt: performance.now(), startFrame: frame };
      return;
    }
    this.#gapClock = undefined;
    const deck = decks[this.#active]!;
    this.#startDeck(deck, clip, clip.sourceIn + frame - clip.start);
  }

  #startDeck(deck: Deck, clip: Clip, sourceFrame: number): void {
    const target = seekTimeForFrame(sourceFrame, this.#fps);
    const frameSeconds = this.#fps.den / this.#fps.num;
    const ready = deck.assetId === clip.assetId && !deck.seeking && Math.abs(deck.video.currentTime - target) < frameSeconds;
    if (!ready) this.#cue(deck, clip, sourceFrame);
    this.#applyVolume(deck, clip);
    this.#setVisible(deck);
    deck.video.play().catch((error: unknown) => {
      // A later pause or seek interrupts play on purpose. Anything else stops playback for real.
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.pause();
      this.onError?.("Trình duyệt không phát được video. Hãy bấm phát lại.");
    });
  }

  #advanceTo(frame: number): void {
    const decks = this.#decks!;
    this.#clearCutTimer();
    this.#frame = frame;
    if (frame >= this.duration) {
      this.pause();
      this.#frame = this.duration;
      this.#current = undefined;
      this.#setVisible(undefined);
      this.#emit();
      return;
    }
    decks[this.#active]!.video.pause();
    this.#active = 1 - this.#active;
    this.#enterFrame(frame);
    this.#emit();
  }

  #prepareNext(afterFrame: number): void {
    const next = clipAt(this.#clips, afterFrame);
    const standby = this.#decks![1 - this.#active]!;
    if (!next) return;
    const target = seekTimeForFrame(next.sourceIn, this.#fps);
    if (standby.assetId === next.assetId && (standby.pendingTime === target || Math.abs(standby.video.currentTime - target) < 1e-3)) return;
    this.#cue(standby, next, next.sourceIn);
  }

  #clearCutTimer(): void {
    clearTimeout(this.#cutTimer);
    this.#cutTimer = undefined;
  }

  #tick = (): void => {
    this.#update();
    if (this.#playing) this.#raf = requestAnimationFrame(this.#tick);
  };

  #update(): void {
    if (!this.#playing || !this.#decks) return;
    const clip = this.#current;
    if (this.#gapClock) {
      const elapsed = (performance.now() - this.#gapClock.startedAt) / 1000;
      const frame = this.#gapClock.startFrame + frameAtTime(elapsed, this.#fps);
      const next = this.#clips.filter((c) => c.start >= this.#gapClock!.startFrame).sort((a, b) => a.start - b.start)[0];
      if (next) this.#prepareNext(next.start);
      const limit = next ? next.start : this.duration;
      if (frame >= limit) {
        this.#advanceTo(limit);
      } else if (frame !== this.#frame) {
        this.#frame = frame;
        this.#emit();
      }
    } else if (clip) {
      const deck = this.#decks[this.#active]!;
      const time = deck.video.currentTime;
      const endTime = ((clip.sourceIn + clip.duration) * this.#fps.den) / this.#fps.num;
      if (endTime - time < PREPARE_AHEAD) this.#prepareNext(clipEnd(clip));
      // While a seek is on its way, currentTime can still describe the previous clip.
      if (deck.pendingTime !== undefined || deck.seeking) {
        // Wait for the deck.
      } else if (time >= endTime - SWITCH_MARGIN || deck.video.ended) {
        this.#advanceTo(clipEnd(clip));
      } else {
        const remaining = endTime - SWITCH_MARGIN - time;
        if (remaining < CUT_TIMER_WINDOW && this.#cutTimer === undefined && !deck.video.paused) {
          this.#cutTimer = setTimeout(() => {
            this.#cutTimer = undefined;
            this.#update();
          }, remaining * 1000);
        }
        const frame = clip.start + Math.max(0, frameAtTime(time, this.#fps) - clip.sourceIn);
        if (frame !== this.#frame) {
          this.#frame = Math.min(frame, clipEnd(clip) - 1);
          this.#emit();
        }
      }
    }
  }

  #emit(): void {
    this.#snapshot = { frame: this.#frame, playing: this.#playing };
    for (const listener of this.#listeners) listener();
  }
}
