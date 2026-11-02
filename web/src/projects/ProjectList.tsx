import { ChevronLeft, Film, Folder, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { frameToTimecode } from "../../../src/time.ts";
import { api, ApiError, type MediaListing, type ProjectSummary } from "../api.ts";
import { slugify } from "../editor/timelineOps.ts";
import { Button, Dialog, EmptyState, Select } from "../ui/ui.tsx";
import styles from "./ProjectList.module.css";

const SIZES = {
  landscape: { label: "Ngang 16:9", detail: "1920 × 1080", width: 1920, height: 1080 },
  portrait: { label: "Dọc 9:16", detail: "1080 × 1920", width: 1080, height: 1920 },
  square: { label: "Vuông 1:1", detail: "1080 × 1080", width: 1080, height: 1080 },
  tall: { label: "Dọc 4:5", detail: "1080 × 1350", width: 1080, height: 1350 },
};

const FRAME_RATES = [
  { value: "30/1", label: "30 fps, mặc định" },
  { value: "25/1", label: "25 fps, khi quay dưới đèn điện 50 Hz" },
  { value: "24/1", label: "24 fps" },
  { value: "30000/1001", label: "29,97 fps" },
  { value: "60/1", label: "60 fps" },
];
type SizeKey = keyof typeof SIZES;

function open(id: string) {
  window.location.hash = `#/p/${encodeURIComponent(id)}`;
}

function FolderDialog({ onChoose, onOpenChange }: { onChoose: (folder: string) => void; onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<MediaListing>();
  const [error, setError] = useState<string>();

  useEffect(() => {
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
  }, [path]);

  const folders = listing?.entries.filter((entry) => entry.kind === "dir") ?? [];

  return (
    <Dialog open onOpenChange={onOpenChange} wide title="Chọn thư mục project" description="Mở thư mục muốn dùng rồi bấm Dùng thư mục này.">
      {(listing?.path || (error && path)) && (
        <Button variant="ghost" className={styles.browserBack} onClick={() => setPath(listing?.parent)}>
          <ChevronLeft size={18} aria-hidden />
          <span className={styles.ellipsis}>{listing?.path ?? "Về danh sách thư mục"}</span>
        </Button>
      )}
      {!listing && !error && <EmptyState title="Đang đọc thư mục..." />}
      {listing && folders.length === 0 && (
        <EmptyState title={listing.path ? "Thư mục này không có thư mục con" : "Chưa có thư mục nào được phép"}>
          {!listing.path && <p>Đặt biến môi trường VE_MEDIA_DIRS rồi khởi động lại server.</p>}
        </EmptyState>
      )}
      {folders.length > 0 && (
        <ul className={styles.browser}>
          {folders.map((entry) => (
            <li key={entry.path}>
              <button type="button" className={styles.browserItem} onClick={() => setPath(entry.path)}>
                <Folder size={18} aria-hidden />
                <span className={styles.ellipsis}>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {listing?.path && (
        <Button variant="primary" className={styles.browserUse} onClick={() => onChoose(listing.path!)}>
          Dùng thư mục này
        </Button>
      )}
    </Dialog>
  );
}

function NewProjectDialog({ open: isOpen, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [size, setSize] = useState<SizeKey>("landscape");
  const [rate, setRate] = useState("30/1");
  const [folder, setFolder] = useState<string>();
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = slugify(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!id) {
      setError("Tên project cần có ít nhất một chữ cái hoặc chữ số.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { width, height } = SIZES[size];
      const [num, den] = rate.split("/").map(Number);
      await api.createProject({ id, name: name.trim(), width, height, fps: { num: num!, den: den! }, ...(folder ? { folder } : {}) });
      open(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không tạo được project.");
      setBusy(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange} title="Project mới">
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span>Tên project</span>
          <input className={styles.input} value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={100} />
        </label>
        <div className={styles.field}>
          <span>Thư mục project</span>
          <div className={styles.folderRow}>
            <span className={styles.ellipsis}>{folder ?? "Mặc định của app"}</span>
            {folder && (
              <Button variant="ghost" type="button" onClick={() => setFolder(undefined)}>
                Dùng mặc định
              </Button>
            )}
            <Button type="button" onClick={() => setChoosingFolder(true)}>
              <Folder size={18} aria-hidden />
              Chọn thư mục
            </Button>
          </div>
          <span className={styles.muted}>Dữ liệu project, bản xem trước và video xuất sẽ nằm ở đây. Video gốc vẫn ở nguyên chỗ cũ.</span>
        </div>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Khung hình</legend>
          <div className={styles.sizes}>
            {(Object.keys(SIZES) as SizeKey[]).map((key) => (
              <label key={key} className={styles.size}>
                <input type="radio" name="size" checked={size === key} onChange={() => setSize(key)} />
                <span>
                  <span className={styles.sizeLabel}>{SIZES[key].label}</span>
                  <span className={styles.muted}>{SIZES[key].detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={styles.field}>
          <span>Số frame mỗi giây</span>
          <Select label="Số frame mỗi giây" value={rate} options={FRAME_RATES} onChange={setRate} />
          <span className={styles.muted}>Không đổi được sau khi tạo. Nên chọn đúng fps lúc quay.</span>
        </div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Đang tạo..." : "Tạo project"}
        </Button>
      </form>
      {choosingFolder && (
        <FolderDialog
          onOpenChange={setChoosingFolder}
          onChoose={(chosen) => {
            setFolder(chosen);
            setChoosingFolder(false);
          }}
        />
      )}
    </Dialog>
  );
}

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [error, setError] = useState<ApiError>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listProjects().then(setProjects, (caught: ApiError) => setError(caught));
  }, []);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Video Editor</h1>
        {projects && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={18} aria-hidden />
            Project mới
          </Button>
        )}
      </header>

      {error?.status === 401 ? (
        <EmptyState title="Chưa có quyền truy cập">
          <p>Hãy mở đường dẫn có token mà server in ra khi chạy lệnh npm start.</p>
        </EmptyState>
      ) : error ? (
        <EmptyState title="Không tải được danh sách project">
          <p>{error.message}</p>
        </EmptyState>
      ) : !projects ? (
        <EmptyState title="Đang tải..." />
      ) : projects.length === 0 ? (
        <EmptyState title="Chưa có project nào">
          <p>Tạo project đầu tiên để bắt đầu dựng video.</p>
        </EmptyState>
      ) : (
        <ul className={styles.list}>
          {projects.map((project) => (
            <li key={project.id}>
              <a className={styles.item} href={`#/p/${encodeURIComponent(project.id)}`}>
                <Film size={20} aria-hidden className={styles.icon} />
                <span className={styles.itemText}>
                  <span className={styles.itemName}>{project.name}</span>
                  <span className={`${styles.muted} ${styles.ellipsis}`}>{project.folder}</span>
                </span>
                <span className={styles.muted}>
                  {project.width} × {project.height}, {Math.round((project.fps.num / project.fps.den) * 100) / 100} fps
                </span>
                <span className={styles.muted}>{project.assetCount} video</span>
                <span className={styles.timecode}>{frameToTimecode(project.durationFrames, project.fps)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {creating && <NewProjectDialog open onOpenChange={setCreating} />}
    </main>
  );
}
