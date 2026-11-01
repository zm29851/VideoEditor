import { CircleCheck, Download } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { frameToTimecode } from "../../../src/time.ts";
import { api, urls } from "../api.ts";
import { Button, Dialog, ProgressBar } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import { timelineEnd } from "./timelineOps.ts";
import styles from "./Editor.module.css";

function defaultName(projectName: string): string {
  return projectName.replace(/[^\p{L}\p{N} _.-]/gu, " ").replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 100) || "export";
}

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { project, projectId, clips, jobs } = useEditor();
  const [name, setName] = useState(() => defaultName(project.name));
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const job = jobs.find((candidate) => candidate.id === jobId);
  const running = jobId !== undefined && (!job || job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (open && job && job.status !== "running" && job.status !== "queued") setError(undefined);
  }, [open, job?.status]);

  async function cancel() {
    if (!jobId) return;
    try {
      await api.cancelJob(projectId, jobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không hủy được.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(undefined);
    try {
      const started = await api.startExport(projectId, name.trim());
      setJobId(started.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không bắt đầu xuất được.");
    }
    setStarting(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Xuất video"
      description={`MP4 H.264, ${project.width} × ${project.height}, dài ${frameToTimecode(timelineEnd(clips), project.fps)}.`}
    >
      {running && (
        <div className={styles.exportState}>
          <p>{job?.status === "running" ? `Đang xuất ${job.progress ?? 0}%` : "Đang chờ tới lượt"}</p>
          <ProgressBar value={job?.progress} label="Tiến độ xuất video" />
          <p className={styles.muted}>Bạn có thể đóng hộp thoại và tiếp tục sửa. Những thay đổi sau lúc này không có trong bản xuất.</p>
          {error && <p role="alert" className={styles.errorText}>{error}</p>}
          <Button onClick={() => void cancel()} disabled={!job}>Hủy xuất video</Button>
        </div>
      )}
      {job?.status === "succeeded" && (
        <div className={styles.exportState}>
          <p className={styles.successText}>
            <CircleCheck size={18} aria-hidden />
            Đã xuất xong {job.label}
          </p>
          <p className={styles.muted}>{(job.result as { path: string }).path}</p>
          <a className={styles.downloadLink} href={urls.exportFile(projectId, job.label!)} download={job.label}>
            <Download size={18} aria-hidden />
            Tải xuống
          </a>
        </div>
      )}
      {job?.status === "cancelled" && <p className={styles.muted}>Đã hủy, không có file nào được giữ lại.</p>}
      {job?.status === "failed" && (
        <div className={styles.exportState} role="alert">
          <p className={styles.errorText}>Xuất video không thành công. Hãy thử lại, nếu vẫn lỗi thì kiểm tra FFmpeg.</p>
          <p className={styles.errorDetail}>{job.error}</p>
        </div>
      )}
      {!running && (
        <form className={styles.exportForm} onSubmit={submit}>
          <label className={styles.field}>
            <span>Tên file</span>
            <input className={styles.input} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </label>
          {error && <p role="alert" className={styles.errorText}>{error}</p>}
          <Button variant={job ? "secondary" : "primary"} type="submit" disabled={starting || !name.trim()}>
            {job ? "Xuất lại" : "Bắt đầu xuất"}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
