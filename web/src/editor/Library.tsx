import { ChevronLeft, Folder, Plus, TriangleAlert, Upload, Video, X } from "lucide-react";
import { useEffect, useState } from "react";
import { frameToTimecode } from "../../../src/time.ts";
import { api, urls, type ImportCheck, type Job, type MediaListing } from "../api.ts";
import { Button, Dialog, EmptyState, IconButton, ProgressBar, useToast } from "../ui/ui.tsx";
import { useEditor } from "./Editor.tsx";
import styles from "./Editor.module.css";

export const ASSET_DRAG_TYPE = "application/x-ve-asset";
/** A drag can only read its data on drop, and the timeline needs the length while hovering. */
export const assetDrag: { assetId?: string } = {};

const THUMBNAIL_FRAME = 15;

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { projectId, refreshStatus } = useEditor();
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<MediaListing>();
  const [error, setError] = useState<string>();
  const [check, setCheck] = useState<ImportCheck>();
  const [checking, setChecking] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListing(undefined);
    setError(undefined);
    api.browseMedia(path).then(
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
  }, [open, path]);

  async function start(videoPath: string) {
    setError(undefined);
    try {
      await api.startImport(projectId, videoPath);
      refreshStatus();
      setCheck(undefined);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không import được video.");
    }
  }

  async function choose(videoPath: string) {
    setChecking(videoPath);
    setError(undefined);
    try {
      const result = await api.checkImport(projectId, videoPath);
      if (result.warning) setCheck(result);
      else await start(videoPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không đọc được video.");
    }
    setChecking(undefined);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Thêm video từ máy"
      description="File gốc không bị sửa. Chỉ hiện thư mục và video."
    >
      {check ? (
        <div className={styles.importWarning} role="alert">
          <p className={styles.warningTitle}>
            <TriangleAlert size={18} aria-hidden />
            {check.name}
          </p>
          <p>{check.warning}</p>
          <p className={styles.muted}>Nên quay cùng fps với project nếu có thể quay lại.</p>
          <div className={styles.dialogActions}>
            <Button onClick={() => setCheck(undefined)}>Chọn video khác</Button>
            <Button variant="primary" onClick={() => void start(check.path)}>
              Vẫn import
            </Button>
          </div>
        </div>
      ) : (
        <>
          {listing?.path && (
            <Button variant="ghost" className={styles.browserBack} onClick={() => setPath(listing.parent)}>
              <ChevronLeft size={18} aria-hidden />
              <span className={styles.ellipsis}>{listing.path}</span>
            </Button>
          )}
          {!listing && !error && <EmptyState title="Đang đọc thư mục..." />}
          {!listing && error && path && (
            <Button variant="ghost" className={styles.browserBack} onClick={() => setPath(undefined)}>
              <ChevronLeft size={18} aria-hidden />
              Về danh sách thư mục
            </Button>
          )}
          {listing && listing.entries.length === 0 && (
            <EmptyState title={listing.path ? "Thư mục này không có video" : "Chưa có thư mục nào được phép"}>
              {!listing.path && <p>Đặt biến môi trường VE_MEDIA_DIRS rồi khởi động lại server.</p>}
            </EmptyState>
          )}
          {listing && listing.entries.length > 0 && (
            <ul className={styles.browser}>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={styles.browserItem}
                    disabled={checking !== undefined}
                    onClick={() => (entry.kind === "dir" ? setPath(entry.path) : void choose(entry.path))}
                  >
                    {entry.kind === "dir" ? <Folder size={18} aria-hidden /> : <Video size={18} aria-hidden />}
                    <span className={styles.ellipsis}>{entry.name}</span>
                    {checking === entry.path && <span className={styles.muted}>Đang kiểm tra...</span>}
                    {entry.sizeBytes !== undefined && checking !== entry.path && (
                      <span className={styles.muted}>{(entry.sizeBytes / 1024 / 1024).toFixed(0)} MB</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p role="alert" className={styles.errorText}>{error}</p>}
    </Dialog>
  );
}

function ImportRow({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
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
      <span className={styles.ellipsis}>{job.label}</span>
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
  const toast = useToast();
  const imports = jobs.filter((job) => job.type === "import" && job.status !== "succeeded" && !dismissed.has(job.id));
  const isEmpty = project.assets.length === 0 && imports.length === 0;

  return (
    <section className={styles.panelLeft} aria-label="Thư viện">
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Thư viện</h2>
      </div>
      <div className={styles.panelBody}>
        <Button onClick={() => setImporting(true)} className={styles.fullWidth}>
          <Upload size={18} aria-hidden />
          Thêm video từ máy
        </Button>
        {isEmpty ? (
          <EmptyState title="Thư viện đang trống">
            <p>Thêm video để bắt đầu dựng.</p>
          </EmptyState>
        ) : (
          <ul className={styles.library}>
            {imports.map((job) => (
              <ImportRow key={job.id} job={job} onDismiss={() => setDismissed((set) => new Set(set).add(job.id))} />
            ))}
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
      </div>
      {importing && <ImportDialog open onOpenChange={setImporting} />}
    </section>
  );
}
