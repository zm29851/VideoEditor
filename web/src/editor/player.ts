import { gainAt, lookAt, tailGainAt, trackEnvelopes, type ClipEnvelope } from "../../../src/animation.ts";
import { isMediaClip, type Asset, type Clip, type FrameRate, type MediaClip, type Track } from "../../../src/schema.ts";
import { clipAt, clipEnd, frameAtTime, seekTimeForFrame, timelineEnd } from "./timelineOps.ts";

/** How long before a cut the next clip is loaded and seeked, in seconds. */
const PREPARE_AHEAD = 2;
/** Switching a touch early means the frame after the cut point never reaches the screen. */
const SWITCH_MARGIN = 1 / 120;
/** Closer than this to a cut, a timer takes over: animation frames slow down when the machine is busy. */
const CUT_TIMER_WINDOW = 0.3;
/** A layer further off than this while playing is put back. Any closer and the correction shows more than the drift. */
const LAYER_DRIFT_SECONDS = 0.1;
/** Each track gets a band of stacking positions, so a dissolve's tail sits under the clip fading in. */
const Z_PER_TRACK = 10;

interface Deck {
  video: HTMLVideoElement;
  assetId?: string;
  /** Asked for while the deck is busy. Only the latest position matters when scrubbing. */
  pendingTime?: number;
  seeking: boolean;
  gain?: GainNode;
}

/** Something other than the main deck that should be on a video element now, or soon. */
interface LayerItem {
  key: string;
  clip: MediaClip;
  sourceFrame: number;
  /** Not on screen yet: the deck is only getting ready. */
  standby: boolean;
  look: { x: number; y: number; scale: number; opacity: number };
  gain: number;
  z: number;
}

export interface PlayerSnapshot {
  frame: number;
  playing: boolean;
}

/** Plays the timeline on two video elements. The hidden one waits at the next clip, so cuts are clean. */
export class Player {
  #decks: [Deck, Deck] | undefined;
  #active = 0;
  #clips: MediaClip[] = [];
  #tracks: Track[] = [];
  #assets: Asset[] = [];
  #envelopes = new Map<string, ClipEnvelope>();
  #duration = 0;
  #mainZ = 1;
  #stage: HTMLElement | undefined;
  #layerClass = "";
  #layerDecks = new Map<string, Deck>();
  #freeDecks: Deck[] = [];
  #fps: FrameRate = { num: 30, den: 1 };
  #proxyUrl: (assetId: string) => string = () => "";
  #frame = 0;
  #playing = false;
  #current: MediaClip | undefined;
  #raf = 0;
  #cutTimer: ReturnType<typeof setTimeout> | undefined;
  #gapClock: { startedAt: number; startFrame: number } | undefined;
  #audio: AudioContext | undefined;
  #listeners = new Set<() => void>();
  #snapshot: PlayerSnapshot = { frame: 0, playing: false };
  onError: ((message: string) => void) | undefined;

  attach(a: HTMLVideoElement, b: HTMLVideoElement, proxyUrl: (assetId: string) => string, stage: HTMLElement): void {
    this.#proxyUrl = proxyUrl;
    this.#stage = stage;
    this.#layerClass = a.className;
    this.#decks = [this.#makeDeck(a), this.#makeDeck(b)];
    this.#active = 0;
    this.#showFrame();
  }

  detach(): void {
    this.pause();
    for (const deck of [...(this.#decks ?? []), ...this.#layerDecks.values(), ...this.#freeDecks]) {
      deck.video.removeAttribute("src");
      deck.video.load();
    }
    for (const deck of [...this.#layerDecks.values(), ...this.#freeDecks]) deck.video.remove();
    this.#layerDecks.clear();
    this.#freeDecks = [];
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
    return this.#duration;
  }

  /** The timeline changed. Playback stops so what is on screen always matches the new timeline. */
  setTimeline(tracks: Track[], assets: Asset[], fps: FrameRate): void {
    const unchanged = JSON.stringify(tracks) === JSON.stringify(this.#tracks);
    const main = tracks.find((track) => track.kind === "video");
    this.#tracks = tracks;
    this.#assets = assets;
    this.#clips = (main?.clips ?? []).filter(isMediaClip);
    this.#mainZ = (main ? tracks.indexOf(main) : 0) * Z_PER_TRACK + 1;
    this.#duration = timelineEnd(tracks.flatMap((track) => track.clips));
    this.#envelopes = new Map(tracks.flatMap((track) => [...trackEnvelopes(track.clips, assets)]));
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
    this.#syncLayers();
    this.#raf = requestAnimationFrame(this.#tick);
    this.#emit();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    cancelAnimationFrame(this.#raf);
    this.#clearCutTimer();
    this.#gapClock = undefined;
    for (const deck of [...(this.#decks ?? []), ...this.#layerDecks.values()]) deck.video.pause();
    this.#emit();
  }

  /** The tracks other than the main clip, and the part of a clip that plays on under a dissolve. */
  #layerItems(): LayerItem[] {
    const frame = this.#frame;
    const fpsRate = this.#fps.num / this.#fps.den;
    const ahead = Math.ceil(PREPARE_AHEAD * fpsRate);
    const items: LayerItem[] = [];
    const main = this.#tracks.find((track) => track.kind === "video");
    this.#tracks.forEach((track, trackIndex) => {
      if (track.kind === "text") return;
      const clips = track.clips.filter(isMediaClip);
      const z = trackIndex * Z_PER_TRACK + 1;
      for (const clip of clips) {
        const envelope = this.#envelopes.get(clip.id)!;
        const position = frame - clip.start;
        if (track !== main && position >= -ahead && position < clip.duration) {
          items.push({
            key: clip.id,
            clip,
            sourceFrame: clip.sourceIn + Math.max(0, position),
            standby: position < 0,
            look: lookAt(clip, Math.max(0, position), envelope),
            gain: gainAt(clip, Math.max(0, position), envelope),
            z,
          });
        }
        const tail = envelope.tail;
        if (tail && isMediaClip(tail.clip) && position >= -ahead && position < tail.frames) {
          const tailFrame = Math.max(0, position);
          items.push({
            key: `${tail.clip.id}:tail`,
            clip: tail.clip,
            sourceFrame: tail.clip.sourceIn + tail.clip.duration + tailFrame,
            standby: position < 0,
            look: { ...lookAt(tail.clip, tail.clip.duration), opacity: lookAt(tail.clip, tail.clip.duration).opacity },
            gain: tailGainAt(tail.clip, tailFrame, tail.frames),
            z: z - 1,
          });
        }
      }
    });
    return items;
  }

  #styleDeck(deck: Deck, clip: MediaClip, look: LayerItem["look"], z: number): void {
    const { style, dataset } = deck.video;
    style.setProperty("--layer-x", String(look.x));
    style.setProperty("--layer-y", String(look.y));
    style.setProperty("--layer-scale", String(look.scale));
    style.setProperty("--layer-opacity", String(look.opacity));
    style.setProperty("--layer-z", String(z));
    dataset.fit = clip.fit ?? "contain";
  }

  /** Brings every layer in line with the current frame. Runs whenever the frame changes. */
  #syncLayers(): void {
    if (!this.#decks || !this.#stage) return;
    if (this.#current) {
      const envelope = this.#envelopes.get(this.#current.id);
      const position = this.#frame - this.#current.start;
      const deck = this.#decks[this.#active]!;
      this.#styleDeck(deck, this.#current, lookAt(this.#current, position, envelope), this.#mainZ);
      this.#setGain(deck, gainAt(this.#current, position, envelope));
    }

    const items = this.#layerItems();
    const wanted = new Set(items.map((item) => item.key));
    for (const [key, deck] of this.#layerDecks) {
      if (wanted.has(key)) continue;
      deck.video.pause();
      deck.video.dataset.visible = "false";
      this.#layerDecks.delete(key);
      this.#freeDecks.push(deck);
    }
    for (const item of items) {
      const deck = this.#layerDecks.get(item.key) ?? this.#takeLayerDeck(item.key);
      const target = seekTimeForFrame(item.sourceFrame, this.#fps);
      const off = Math.abs(deck.video.currentTime - target);
      const frameSeconds = this.#fps.den / this.#fps.num;
      if (deck.assetId !== item.clip.assetId || (this.#playing && !item.standby ? off > LAYER_DRIFT_SECONDS : off > frameSeconds / 2 && deck.pendingTime !== target)) {
        this.#cue(deck, item.clip, item.sourceFrame);
      }
      this.#styleDeck(deck, item.clip, item.look, item.z);
      this.#setGain(deck, item.standby ? 0 : item.gain);
      const hasPicture = this.#assets.find((asset) => asset.id === item.clip.assetId)?.hasVideo === true;
      deck.video.dataset.visible = String(!item.standby && hasPicture);
      if (this.#playing && !item.standby && deck.video.paused) {
        deck.video.play().catch(() => {
          // A layer that cannot start stays quiet. The main clip reports problems with the file.
        });
      } else if (item.standby && !deck.video.paused) {
        deck.video.pause();
      }
    }
  }

  #takeLayerDeck(key: string): Deck {
    let deck = this.#freeDecks.pop();
    if (!deck) {
      const video = document.createElement("video");
      video.className = this.#layerClass;
      video.playsInline = true;
      video.preload = "auto";
      video.dataset.visible = "false";
      this.#stage!.append(video);
      deck = this.#makeDeck(video);
    }
    this.#layerDecks.set(key, deck);
    return deck;
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

  #cue(deck: Deck, clip: MediaClip, sourceFrame: number): void {
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

  #setGain(deck: Deck, gain: number): void {
    if (this.#audio && !deck.gain) {
      deck.gain = this.#audio.createGain();
      this.#audio.createMediaElementSource(deck.video).connect(deck.gain).connect(this.#audio.destination);
    }
    // Same linear scale as the volume filter in export, and it can go above 100%.
    if (deck.gain) deck.gain.gain.value = gain;
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
    this.#syncLayers();
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

  #startDeck(deck: Deck, clip: MediaClip, sourceFrame: number): void {
    const target = seekTimeForFrame(sourceFrame, this.#fps);
    const frameSeconds = this.#fps.den / this.#fps.num;
    const ready = deck.assetId === clip.assetId && !deck.seeking && Math.abs(deck.video.currentTime - target) < frameSeconds;
    if (!ready) this.#cue(deck, clip, sourceFrame);
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
    this.#syncLayers();
    this.#snapshot = { frame: this.#frame, playing: this.#playing };
    for (const listener of this.#listeners) listener();
  }
}
