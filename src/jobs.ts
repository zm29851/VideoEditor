import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  type: string;
  projectId: string;
  /** What the job works on, in words a person can read, such as a file name. */
  label?: string;
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
}

const KEPT_FINISHED_JOBS = 200;

/** Heavy media work runs one job at a time, so an import cannot starve an export on this hardware. */
export class JobQueue {
  #jobs = new Map<string, Job>();
  #tail: Promise<void> = Promise.resolve();
  #waiters = new Map<string, Array<() => void>>();

  enqueue(type: string, projectId: string, work: (context: JobContext) => Promise<unknown>, label?: string): Job {
    const job: Job = {
      id: `job_${randomUUID().slice(0, 8)}`,
      type,
      projectId,
      ...(label === undefined ? {} : { label }),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.#jobs.set(job.id, job);
    this.#tail = this.#tail.then(() => this.#run(job, work));
    this.#prune();
    return { ...job };
  }

  get(id: string): Job | undefined {
    const job = this.#jobs.get(id);
    return job && { ...job };
  }

  listForProject(projectId: string): Job[] {
    return [...this.#jobs.values()].filter((job) => job.projectId === projectId).map((job) => ({ ...job }));
  }

  /** Resolves when the job finishes or the wait runs out, whichever comes first. */
  async wait(id: string, milliseconds: number): Promise<Job | undefined> {
    const job = this.#jobs.get(id);
    if (!job || milliseconds <= 0 || job.status === "succeeded" || job.status === "failed") return this.get(id);
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
    job.status = "running";
    try {
      job.result = await work({
        setProgress: (percent) => {
          job.progress = Math.min(100, Math.max(0, Math.round(percent)));
        },
        setStage: (stage) => {
          job.stage = stage;
        },
      });
      job.status = "succeeded";
      job.progress = 100;
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
    job.finishedAt = new Date().toISOString();
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
