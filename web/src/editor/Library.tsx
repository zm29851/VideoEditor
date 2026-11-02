import { ChevronLeft, Folder, Music, Plus, TriangleAlert, Upload, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { frameToTimecode } from "../../../src/time.ts";
import { api, urls, type ImportCheck, type Job, type MediaListing } from "../api.ts";
import { Button, Checkbox, Dialog, EmptyState, IconButton, ProgressBar, useToast } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import { formatSize, groupByWarning, importOrder, rangeBetween, selectAllState, type ImportCandidate } from "./importSelection.ts";
import styles from "./Editor.module.css";

export const ASSET_DRAG_TYPE = "application/x-ve-asset";
/** A drag can only read its data on drop, and the timeline needs the length while hovering. */
export const assetDrag: { assetId?: string } = {};

const THUMBNAIL_FRAME = 15;

interface ImportFailure {
  name: string;
  path: string;
  failure: string;
  detail?: string;
}

type Reviewed = ImportCheck | ImportFailure;

interface Review {
  ready: ImportCheck[];
  warned: ImportCheck[];
  failed: ImportFailure[];
}

function sortChecks(checks: Reviewed[]): Review {
  const review: Review = { ready: [], warned: [], failed: [] };
  for (const check of checks) {
    if ("failure" in check) review.failed.push(check);
    else if (check.warning) review.warned.push(check);
    else review.ready.push(check);
  }
  return review;
}

function ImportReview({ review, onBack, onImport }: { review: Review; onBack: () => void; onImport: (paths: string[]) => void }) {
  const { ready, warned, failed } = review;
  const paths = (checks: ImportCheck[]) => checks.map((check) => check.path);
  return (
    <div className={styles.importWarning} role="alert">
      <div className={styles.importReview}>
        {groupByWarning(warned).map(({ warning, files }) => (
          <div key={warning} className={styles.importReviewGroup}>
            <p className={styles.warningTitle}>
              <TriangleAlert size={18} aria-hidden />
              {warning}
            </p>
            <ul className={styles.importReviewFiles}>
              {files.map((file) => (
                <li key={file.path} className={styles.importReviewFile}>{file.name}</li>
              ))}
            </ul>
          </div>
        ))}
        {warned.length > 0 && <p className={styles.muted}>Nên quay cùng fps với project nếu có thể quay lại.</p>}
        {failed.length > 0 && (
          <div className={styles.importReviewGroup}>
            <p className={styles.warningTitle}>
              <TriangleAlert size={18} aria-hidden />
              {failed.length} file không import được và sẽ bị bỏ qua
            </p>
            <ul className={styles.importReviewFiles}>
              {failed.map((file) => (
                <li key={file.path} className={styles.importReviewFile}>
                  {file.name}
                  <span className={styles.errorText} title={file.detail}>{file.failure}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className={styles.dialogActions}>
        <Button onClick={onBack}>Quay lại chọn file</Button>
        {warned.length > 0 && ready.length > 0 && (
          <Button onClick={() => onImport(paths(ready))}>Bỏ {warned.length} file có cảnh báo</Button>
        )}
        {warned.length > 0 && (
          <Button variant="primary" onClick={() => onImport(paths([...ready, ...warned]))}>
            Vẫn import {ready.length + warned.length} file
          </Button>
        )}
        {warned.length === 0 && ready.length > 0 && (
          <Button variant="primary" onClick={() => onImport(paths(ready))}>
            Import {ready.length} file còn lại
          </Button>
        )}
      </div>
    </div>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { project, projectId, jobs } = useEditor();
  const [path, setPath] = useState<string>();
  const [atProject, setAtProject] = useState(true);
  const [listing, setListing] = useState<MediaListing>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ReadonlyMap<string, ImportCandidate>>(new Map());
  const [review, setReview] = useState<Review>();
  const [progress, setProgress] = useState<{ title: string; done: number; total: number }>();
  const anchor = useRef<string>(undefined);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  function go(next: string | undefined) {
    setAtProject(false);
    setPath(next);
  }

  // Every time it opens, it starts from the project's own folder.
  useEffect(() => {
    if (open) setAtProject(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListing(undefined);
    setError(undefined);
    (atProject ? api.browseProjectMedia(projectId) : api.browseMedia(path)).then(
      (result) => {
        if (!cancelled) setListing(result);
      },
      (caught: Error) => {
        if (!cancelled) setError(caught.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, path, atProject, projectId]);

  const files = listing?.entries.filter((entry) => entry.kind !== "dir") ?? [];
  const imported = new Set(project.assets.map((asset) => asset.originalPath));
  // A job only knows the file's name, which is enough for a hint that can still be overridden.
  const importingNames = new Set(jobs.filter((job) => job.type === "import" && (job.status === "queued" || job.status === "running")).map((job) => job.label));
  const note = (file: ImportCandidate) => (imported.has(file.path) ? "Đã có trong Thư viện" : importingNames.has(file.name) ? "Đang import" : undefined);
  const selectable = files.filter((file) => !note(file));
  const totalBytes = [...selected.values()].reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);

  function toggle(file: ImportCandidate, shiftKey: boolean) {
    const on = !selected.has(file.path);
    const range = shiftKey ? rangeBetween(files, anchor.current, file.path).filter((item) => item.path === file.path || !note(item)) : [file];
    anchor.current = file.path;
    setSelected((current) => {
      const next = new Map(current);
      for (const item of range) {
        if (on) next.set(item.path, item);
        else next.delete(item.path);
      }
      return next;
    });
  }

  function toggleAll() {
    const on = selectAllState(selectable, selected) !== true;
    setSelected((current) => {
      const next = new Map(current);
      for (const file of selectable) {
        if (on) next.set(file.path, file);
        else next.delete(file.path);
      }
      return next;
    });
  }

  async function startAll(paths: string[]) {
    setReview(undefined);
    setError(undefined);
    const failed: Review["failed"] = [];
    for (const [index, videoPath] of paths.entries()) {
      setProgress({ title: "Đang đưa vào hàng đợi", done: index, total: paths.length });
      try {
        await api.startImport(projectId, videoPath);
      } catch (caught) {
        failed.push({ name: selected.get(videoPath)?.name ?? videoPath, path: videoPath, failure: caught instanceof Error ? caught.message : "Không import được file này." });
      }
    }
    setProgress(undefined);
    if (failed.length === 0) onOpenChange(false);
    else {
      const started = new Set(paths.filter((videoPath) => !failed.some((file) => file.path === videoPath)));
      setSelected((current) => new Map([...current].filter(([key]) => !started.has(key))));
      setReview({ ready: [], warned: [], failed });
    }
  }

  async function checkAll() {
    const candidates = importOrder(selected.values());
    const checks: Reviewed[] = [];
    setError(undefined);
    // One at a time: reading dozens of files at once would make this machine crawl.
    for (const [index, file] of candidates.entries()) {
      if (closed.current) return;
      setProgress({ title: "Đang kiểm tra", done: index, total: candidates.length });
      try {
        checks.push(await api.checkImport(projectId, file.path));
      } catch (caught) {
        // ffprobe's own words mean little here, so they stay in a tooltip for whoever needs them.
        checks.push({ name: file.name, path: file.path, failure: "Không đọc được file này, có thể file đã hỏng.", ...(caught instanceof Error ? { detail: caught.message } : {}) });
      }
    }
    if (closed.current) return;
    setProgress(undefined);
    const sorted = sortChecks(checks);
    if (sorted.warned.length === 0 && sorted.failed.length === 0) await startAll(sorted.ready.map((check) => check.path));
    else setReview(sorted);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Thêm video hoặc âm thanh từ máy"
      description="Chọn một hoặc nhiều file. File gốc không bị sửa. Chỉ hiện thư mục, video và file âm thanh."
    >
      {progress ? (
        <div className={styles.exportState}>
          <p role="status">{progress.title} {progress.done + 1}/{progress.total}</p>
          <ProgressBar value={(progress.done / progress.total) * 100} label={progress.title} />
        </div>
      ) : review ? (
        <ImportReview review={review} onBack={() => setReview(undefined)} onImport={(paths) => void startAll(paths)} />
      ) : (
        <>
          {listing?.path && (
            <Button variant="ghost" className={styles.browserBack} onClick={() => go(listing.parent)}>
              <ChevronLeft size={18} aria-hidden />
              <span className={styles.ellipsis}>{listing.path}</span>
            </Button>
          )}
          {!listing && !error && <EmptyState title="Đang đọc thư mục..." />}
          {!listing && error && (path || atProject) && (
            <Button variant="ghost" className={styles.browserBack} onClick={() => go(undefined)}>
              <ChevronLeft size={18} aria-hidden />
              Về danh sách thư mục
            </Button>
          )}
          {listing && listing.entries.length === 0 && (
            <EmptyState title={listing.path ? "Thư mục này không có video hay âm thanh" : "Chưa có thư mục nào được phép"}>
              {!listing.path && <p>Đặt biến môi trường VE_MEDIA_DIRS rồi khởi động lại server.</p>}
            </EmptyState>
          )}
          {selectable.length > 1 && (
            <Checkbox checked={selectAllState(selectable, selected)} onClick={toggleAll} className={styles.browserSelectAll}>
              Chọn tất cả ({selectable.length} file)
            </Checkbox>
          )}
          {listing && listing.entries.length > 0 && (
            <ul className={styles.browser}>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  {entry.kind === "dir" ? (
                    <button type="button" className={styles.browserItem} onClick={() => go(entry.path)}>
                      <Folder size={18} aria-hidden />
                      <span className={`${styles.ellipsis} ${styles.browserName}`}>{entry.name}</span>
                    </button>
                  ) : (
                    <Checkbox checked={selected.has(entry.path)} onClick={(event) => toggle(entry, event.shiftKey)} className={styles.browserItem}>
                      {entry.kind === "audio" ? <Music size={18} aria-hidden /> : <Video size={18} aria-hidden />}
                      <span className={`${styles.ellipsis} ${styles.browserName}`}>{entry.name}</span>
                      {note(entry) && <span className={styles.muted}>{note(entry)}</span>}
                      {entry.sizeBytes !== undefined && <span className={styles.muted}>{formatSize(entry.sizeBytes)}</span>}
                    </Checkbox>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(files.length > 0 || selected.size > 0) && (
            <div className={styles.importFooter}>
              <span className={`${styles.muted} ${styles.importSummary}`} aria-live="polite">
                {selected.size === 0 ? "Chưa chọn file nào" : `Đã chọn ${selected.size} file · ${formatSize(totalBytes)}`}
              </span>
              {selected.size > 0 && (
                <Button variant="ghost" onClick={() => setSelected(new Map())}>Bỏ chọn</Button>
              )}
              <Button variant="primary" disabled={selected.size === 0} onClick={() => void checkAll()}>
                {selected.size === 0 ? "Thêm" : `Thêm ${selected.size} file`}
              </Button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className={styles.errorText}>{error}</p>}
    </Dialog>
  );
}

function ImportRow({ job, onDismiss, onCancel }: { job: Job; onDismiss: () => void; onCancel: () => void }) {
  if (job.status === "failed") {
    return (
      <li className={styles.libraryFailed} role="alert">
        <div className={styles.libraryText}>
          <span className={styles.ellipsis}>{job.label}</span>
          <span className={styles.errorText}>Import không thành công. Hãy kiểm tra file rồi thử lại.</span>
          <span className={styles.errorDetail}>{job.error}</span>
        </div>
        <IconButton label="Bỏ thông báo này" onClick={onDismiss}>
          <X size={16} aria-hidden />
        </IconButton>
      </li>
    );
  }
  return (
    <li className={styles.libraryProgress}>
      <div className={styles.jobLine}>
        <span className={styles.ellipsis}>{job.label}</span>
        <IconButton label={`Hủy import ${job.label ?? ""}`} onClick={onCancel}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <span className={styles.muted}>
        {job.status === "queued" ? "Đang chờ tới lượt" : (job.stage ?? "Đang xử lý")}
        {job.progress !== undefined && job.status === "running" ? ` · ${job.progress}%` : ""}
      </span>
      <ProgressBar value={job.progress} label={`Tiến độ import ${job.label ?? ""}`} />
    </li>
  );
}

export function Library() {
  const { project, projectId, jobs, addAsset } = useEditor();
  const [importing, setImporting] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const report = (caught: unknown) => toast(caught instanceof Error ? caught.message : "Không thực hiện được.");
  const toast = useToast();
  const imports = jobs.filter((job) => job.type === "import" && job.status !== "succeeded" && job.status !== "cancelled" && !dismissed.has(job.id));
  const isEmpty = project.assets.length === 0 && imports.length === 0;
  const waiting = imports.filter((job) => job.status === "queued");
  // One waiting file reads best as its usual row. Dozens would push the Library out of sight.
  const rows = waiting.length > 1 ? imports.filter((job) => job.status !== "queued") : imports;

  const importRow = (job: Job) => (
    <ImportRow
      key={job.id}
      job={job}
      onCancel={() => void api.cancelJob(projectId, job.id).catch(report)}
      onDismiss={() => {
        setDismissed((set) => new Set(set).add(job.id));
        void api.dismissJob(projectId, job.id).catch(report);
      }}
    />
  );

  return (
    <>
      <Button onClick={() => setImporting(true)} className={styles.fullWidth}>
        <Upload size={18} aria-hidden />
        Thêm video hoặc âm thanh
      </Button>
      {isEmpty ? (
        <EmptyState title="Thư viện đang trống">
          <p>Thêm video để bắt đầu dựng. Nhạc nền cũng thêm ở đây.</p>
        </EmptyState>
      ) : (
        <ul className={styles.library}>
          {rows.filter((job) => job.status !== "failed").map(importRow)}
          {waiting.length > 1 && (
            <li className={styles.jobLine}>
              <span className={styles.muted} role="status">Đang chờ {waiting.length} file</span>
              <Button variant="ghost" onClick={() => void Promise.all(waiting.map((job) => api.cancelJob(projectId, job.id))).catch(report)}>
                Hủy tất cả
              </Button>
            </li>
          )}
          {rows.filter((job) => job.status === "failed").map(importRow)}
          {project.assets.map((asset) => (
            <li
              key={asset.id}
              className={styles.libraryItem}
              draggable
              onDragStart={(event) => {
                assetDrag.assetId = asset.id;
                event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={() => {
                delete assetDrag.assetId;
              }}
            >
              {asset.hasVideo ? (
                <img
                  className={styles.thumb}
                  src={urls.thumbnail(projectId, asset.id, Math.min(THUMBNAIL_FRAME, asset.durationFrames - 1))}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  onError={(event) => {
                    event.currentTarget.hidden = true;
                  }}
                />
              ) : (
                <span className={styles.libraryIcon}>
                  <Music size={20} aria-hidden />
                </span>
              )}
              <div className={styles.libraryText}>
                <span className={styles.ellipsis} title={asset.name}>{asset.name}</span>
                <span className={styles.timecode}>{frameToTimecode(asset.durationFrames, project.fps)}</span>
                {asset.normalization.transcoded && (
                  <span className={styles.muted} title={asset.normalization.reasons.join("; ")}>Đã chuẩn hóa</span>
                )}
              </div>
              <IconButton
                label={`Thêm ${asset.name} vào cuối timeline`}
                onClick={() => {
                  try {
                    addAsset(asset);
                  } catch (error) {
                    toast(error instanceof Error ? error.message : "Không thêm được clip.");
                  }
                }}
              >
                <Plus size={18} aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {importing && <ImportDialog open onOpenChange={setImporting} />}
    </>
  );
}
