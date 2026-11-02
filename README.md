# Video Editor

Web app dựng video mà cả người và AI agent cùng sửa trên một timeline. Bạn dựng trên trình duyệt, agent như Claude Code dựng qua MCP, và cả hai thấy thay đổi của nhau ngay lập tức. Mọi thứ chạy trên máy của bạn.

Có sẵn: cắt ghép theo frame, nhiều track video, âm thanh và chữ, phụ đề từ lời nói, transition, keyframe, các tỉ lệ khung hình, sửa video bằng transcript, bỏ khoảng lặng, hoàn tác từng lô.

Yêu cầu: Node 22.18 trở lên, `ffmpeg` và `ffprobe` trên PATH. Muốn có transcript và phụ đề thì cần thêm `whisper-cli` và model, xem [Transcript](#transcript-và-phụ-đề).

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

Khi tạo project, có thể chọn một thư mục có sẵn làm thư mục project: dữ liệu project, bản xem trước và video xuất nằm ở đó, và hộp thoại thêm video mở sẵn thư mục này. Không chọn thì project nằm trong `VE_PROJECTS_DIR`. Mã nguồn app và token vẫn ở chỗ cũ.

Bấm `?` trong màn hình dựng để xem phím tắt. Video và âm thanh chọn được từ mọi thư mục trên máy, file gốc không bị sao chép hay sửa. Muốn giới hạn thì đặt `VE_MEDIA_DIRS`.

### Một lượt dựng

1. Bấm **Project mới**, đặt tên, chọn khung hình và fps. Fps không đổi được sau khi tạo, nên chọn đúng fps lúc quay.
2. Bấm **Thêm video hoặc âm thanh**, chọn một hoặc nhiều file (Shift và bấm để chọn cả đoạn, hoặc Chọn tất cả), rồi bấm Thêm. Các file được import lần lượt. Video chuyển sang fps của project và tạo bản xem trước, có tiến độ trong Thư viện và có thể hủy.
3. Kéo video xuống timeline, cắt bằng `S`, xóa bằng `Delete`, xóa và dồn bằng `⇧Delete`.
4. Tab **Transcript**: tạo transcript, chọn từ rồi `Delete` để cắt theo lời nói, hoặc bấm **Tạo phụ đề**.
5. Chọn clip để chỉnh ở tab **Thuộc tính**: vị trí, cỡ, độ rõ, âm lượng, transition. Nút hình thoi đặt keyframe tại playhead.
6. Nghe lại rồi bấm **Xuất video**. File nằm trong `<project>/exports/`.

Track sau vẽ đè lên track trước. Nhạc nền đặt trên track âm thanh riêng, nên không bị cắt khi xóa lời nói. Khi chưa chọn clip, tab Thuộc tính cho đổi khung hình.

### Transcript và phụ đề

App tìm `whisper-cli` theo `VE_WHISPER_BIN`, PATH rồi `~/.local/bin`. Model tìm theo `VE_WHISPER_MODEL` rồi `~/.local/share/whisper`, ưu tiên `ggml-large-v3-turbo.bin`. VAD tìm theo `VE_WHISPER_VAD` rồi cùng thư mục đó, tên `ggml-silero-v5.1.2.bin`. Thời gian từng từ có thể lệch vài phần mười giây, nên hãy nghe lại trước khi xuất.

Khi phát triển giao diện, chạy server bằng `npm run mcp` rồi chạy `npm run web:dev` ở terminal khác.

## Kết nối AI agent qua MCP

Chạy `npm start`, hoặc `npm run mcp` nếu giao diện đã được build. Server in ra lệnh `claude mcp add ...` kèm token để chạy một lần. Sau đó, trong Claude Code, bạn chỉ cần yêu cầu bằng lời, ví dụ "import video này, bỏ đoạn đầu rồi export".

Server chỉ nghe trên `127.0.0.1`, yêu cầu token, và từ chối Host hoặc Origin lạ. Token nằm trong `projects/.mcp-token`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `VE_PROJECTS_DIR` | `projects` | Nơi lưu project |
| `VE_MCP_PORT` | `8765` | Cổng của server |
| `VE_MEDIA_DIRS` | `/`, tức toàn bộ máy | Thư mục được phép import video và âm thanh, cả với agent |
| `VE_MCP_TOKEN` | Tự tạo | Token cố định, nếu muốn tự đặt |

File xuất nằm trong `<project>/exports/`, bản xem trước nằm trong `<project>/previews/`.

Công cụ cho agent:

- **Đọc:** `list_projects`, `get_timeline`, `get_asset_info`, `get_history`
- **Nhìn:** `get_frame`, `get_filmstrip`
- **Sửa:** `create_project`, `import_asset`, `add_clip`, `split_clip`, `trim_clip`, `move_clip`, `delete_clip`, `delete_ranges`, `set_volume`, `apply_batch`, `undo`, `redo`
- **Lớp và hiệu ứng:** `add_track`, `remove_track`, `add_text`, `set_text`, `generate_subtitles`, `set_transform`, `set_keyframes`, `set_transition`, `set_canvas`
- **Phân tích:** `transcribe_asset`, `get_transcript`, `detect_silence`, `detect_scenes`, `get_loudness`
- **Xuất:** `render_preview`, `export_video`, `get_job_status`, `cancel_job`

Khi cập nhật app, hãy khởi động lại server và kết nối lại agent để agent thấy công cụ mới.

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
- Fps của project chọn khi tạo (mặc định 30) và không đổi sau đó. Mọi vị trí trên timeline và trong nguồn đều là số nguyên frame ở fps đó.
- File gốc không bao giờ bị sửa. Khi import, video sai fps, fps không đều, HDR hoặc sai định dạng được chuyển thành master; video đạt chuẩn dùng thẳng file gốc.
- Proxy có đúng số frame như master. Export luôn lấy từ master.
