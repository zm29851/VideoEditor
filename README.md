# Video Editor

Web app dựng video mà cả người và AI agent cùng sửa trên một timeline. Hiện đã có lõi xử lý video, MCP server cho agent và giao diện dựng video trên trình duyệt.

Yêu cầu: Node 22.18 trở lên, `ffmpeg` và `ffprobe` trên PATH.

```bash
npm install
```

```bash
npm test
```

## Dựng video trên trình duyệt

```bash
npm start
```

Lệnh này build giao diện rồi chạy server. Mở đường dẫn có `?token=...` mà server in ra. Trình duyệt sẽ giữ token trong cookie nên những lần sau chỉ cần mở `http://127.0.0.1:8765`.

Bấm `?` trong màn hình dựng để xem phím tắt. Video chọn được từ mọi thư mục trên máy, file gốc không bị sao chép hay sửa. Muốn giới hạn thì đặt `VE_MEDIA_DIRS`.

Khi phát triển giao diện, chạy server bằng `npm run mcp` rồi chạy `npm run web:dev` ở terminal khác.

## Kết nối AI agent qua MCP

Chạy `npm start`, hoặc `npm run mcp` nếu giao diện đã được build. Server in ra lệnh `claude mcp add ...` kèm token để chạy một lần. Sau đó, trong Claude Code, bạn chỉ cần yêu cầu bằng lời, ví dụ "import video này, bỏ đoạn đầu rồi export".

Server chỉ nghe trên `127.0.0.1`, yêu cầu token, và từ chối Host hoặc Origin lạ. Token nằm trong `projects/.mcp-token`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `VE_PROJECTS_DIR` | `projects` | Nơi lưu project |
| `VE_MCP_PORT` | `8765` | Cổng của server |
| `VE_MEDIA_DIRS` | `/`, tức toàn bộ máy | Thư mục được phép import video, cả với agent |
| `VE_MCP_TOKEN` | Tự tạo | Token cố định, nếu muốn tự đặt |

File xuất nằm trong `<project>/exports/`, bản xem trước nằm trong `<project>/previews/`.

Công cụ cho agent:

- **Đọc:** `list_projects`, `get_timeline`, `get_asset_info`, `get_history`
- **Nhìn:** `get_frame`, `get_filmstrip`
- **Sửa:** `create_project`, `import_asset`, `add_clip`, `split_clip`, `trim_clip`, `move_clip`, `delete_clip`, `set_volume`, `apply_batch`, `undo`, `redo`
- **Xuất:** `render_preview`, `export_video`, `get_job_status`

## Thử bằng dòng lệnh

```bash
npm run cli -- create projects/demo --name "Demo"
```

```bash
npm run cli -- import projects/demo /đường/dẫn/video.mov
```

```bash
npm run cli -- apply projects/demo commands.json
```

```bash
npm run cli -- export projects/demo out.mp4
```

`commands.json` là một mảng lệnh, với `assetId` lấy từ kết quả `import`. Mọi vị trí đều tính bằng frame:

```json
[
  { "type": "add_clip", "trackId": "video_1", "assetId": "asset_xxx", "start": 0, "sourceIn": 30, "duration": 90 },
  { "type": "add_clip", "trackId": "video_1", "assetId": "asset_xxx", "start": 90, "sourceIn": 300, "duration": 60 }
]
```

## Nguyên tắc

- Mọi thay đổi đi qua `CommandEngine`: nguyên tử theo lô, kiểm tra revision, undo theo lô, ghi lại người sửa.
- Fps của project cố định khi tạo (mặc định 30). Mọi vị trí trên timeline và trong nguồn đều là số nguyên frame ở fps đó.
- File gốc không bao giờ bị sửa. Khi import, video sai fps, fps không đều, HDR hoặc sai định dạng được chuyển thành master; video đạt chuẩn dùng thẳng file gốc.
- Proxy có đúng số frame như master. Export luôn lấy từ master.
