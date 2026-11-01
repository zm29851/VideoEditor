import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  type: string;
  projectId: string;
  /** What the job works on, in words a person can read, such as a file name. */
  label?: string;
  /** The video this job works on, when there is exactly one. */
  assetId?: string;
  status: JobStatus;
  /** 0 to 100 when the work can measure itself. */
  progress?: number;
  stage?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface JobContext {
  setProgress(percent: number): void;
  setStage(stage: string): void;
  /** Aborts when someone cancels the job. Pass it to whatever runs for a long time. */
  signal: AbortSignal;
}

export function isFinished(job: Job): boolean {
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}

const KEPT_FINISHED_JOBS = 200;

export type JobListener = (job: Job) => void;

/** Heavy media work runs one job at a time, so an import cannot starve an export on this hardware. */
export class JobQueue {
  #jobs = new Map<string, Job>();
  #tail: Promise<void> = Promise.resolve();
  #waiters = new Map<string, Array<() => void>>();
  #listeners = new Set<JobListener>();
  #controllers = new Map<string, AbortController>();
  #file: string | undefined;

  /**
   * With a file, finished jobs and their results survive a restart. Work that was under way cannot
   * continue, since its code lived in the old process, so it is reported as interrupted.
   */
  constructor(file?: string) {
    this.#file = file;
    if (!file || !existsSync(file)) return;
    let saved: Job[];
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Job[];
    } catch {
      return;
    }
    for (const job of saved) {
      if (!isFinished(job)) {
        job.status = "failed";
        job.error = "Việc này bị dừng vì server đã khởi động lại. Hãy chạy lại nếu vẫn cần.";
        job.finishedAt = new Date().toISOString();
      }
      this.#jobs.set(job.id, job);
    }
    this.#save();
  }

  #save(): void {
    if (!this.#file) return;
    try {
      writeFileSync(`${this.#file}.tmp`, JSON.stringify([...this.#jobs.values()]), { mode: 0o600 });
      renameSync(`${this.#file}.tmp`, this.#file);
    } catch (error) {
      // Only the record after a restart is lost. The work itself must not fail because of it.
      console.error("Không lưu được danh sách job:", error);
    }
  }

  /** Called whenever a job starts, moves on or finishes. Returns the function that stops the calls. */
  subscribe(listener: JobListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(job: Job): void {
    for (const listener of this.#listeners) listener({ ...job });
  }

  enqueue(type: string, projectId: string, work: (context: JobContext) => Promise<unknown>, label?: string, assetId?: string): Job {
    const job: Job = {
      id: `job_${randomUUID().slice(0, 8)}`,
      type,
      projectId,
      ...(label === undefined ? {} : { label }),
      ...(assetId === undefined ? {} : { assetId }),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.#jobs.set(job.id, job);
    this.#tail = this.#tail.then(() => this.#run(job, work));
    this.#prune();
    this.#save();
    this.#notify(job);
    return { ...job };
  }

  get(id: string): Job | undefined {
    const job = this.#jobs.get(id);
    return job && { ...job };
  }

  /** A waiting job never starts. A running one is stopped and cleans up after itself. */
  cancel(id: string): Job {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Không có job "${id}".`);
    if (isFinished(job)) throw new Error(`Job "${id}" đã kết thúc nên không hủy được nữa.`);
    if (job.status === "queued") this.#finish(job, "cancelled");
    else this.#controllers.get(id)?.abort();
    return { ...job };
  }

  /** Takes a finished job off the list, once its message has been read. */
  dismiss(id: string): void {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Không có job "${id}".`);
    if (!isFinished(job)) throw new Error(`Job "${id}" chưa kết thúc. Hãy hủy trước.`);
    this.#jobs.delete(id);
    this.#save();
  }

  listForProject(projectId: string): Job[] {
    return [...this.#jobs.values()].filter((job) => job.projectId === projectId).map((job) => ({ ...job }));
  }

  /** Resolves when the job finishes or the wait runs out, whichever comes first. */
  async wait(id: string, milliseconds: number): Promise<Job | undefined> {
    const job = this.#jobs.get(id);
    if (!job || milliseconds <= 0 || isFinished(job)) return this.get(id);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#waiters.set(id, waiters);
    });
    return this.get(id);
  }

  async #run(job: Job, work: (context: JobContext) => Promise<unknown>): Promise<void> {
    if (job.status !== "queued") return;
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);
    job.status = "running";
    this.#save();
    this.#notify(job);
    try {
      job.result = await work({
        signal: controller.signal,
        setProgress: (percent) => {
          const progress = Math.min(100, Math.max(0, Math.round(percent)));
          if (progress === job.progress) return;
          job.progress = progress;
          this.#notify(job);
        },
        setStage: (stage) => {
          if (stage === job.stage) return;
          job.stage = stage;
          this.#notify(job);
        },
      });
      job.progress = 100;
      this.#finish(job, "succeeded");
    } catch (error) {
      if (!controller.signal.aborted) job.error = error instanceof Error ? error.message : String(error);
      this.#finish(job, controller.signal.aborted ? "cancelled" : "failed");
    }
    this.#controllers.delete(job.id);
  }

  #finish(job: Job, status: "succeeded" | "failed" | "cancelled"): void {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    this.#save();
    this.#notify(job);
    for (const waiter of this.#waiters.get(job.id) ?? []) waiter();
    this.#waiters.delete(job.id);
  }

  #prune(): void {
    const finished = [...this.#jobs.values()].filter((job) => job.finishedAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED_JOBS))) {
      this.#jobs.delete(job.id);
    }
  }
}
