# AGENTS.md

Hướng dẫn kỹ thuật và tiến độ cho mọi người và AI agent làm việc trong repo này.

## Quy tắc bắt buộc

1. **Trước mỗi lần tạo mới hoặc chỉnh sửa giao diện, phải đọc lại toàn bộ [DESIGN.md](DESIGN.md).** Việc này áp dụng cho cả thay đổi nhỏ, và không dựa vào trí nhớ từ lần đọc trước.
2. Mọi thay đổi dữ liệu project phải đi qua `CommandEngine`. UI và MCP không được sửa timeline trực tiếp.
3. Khi xong một việc trong [Tiến độ](#tiến-độ-dự-án), cập nhật checklist ngay trong cùng thay đổi. Chỉ đánh dấu xong khi đã kiểm chứng.
4. Không commit video, thư mục `projects/` hay token. Repo đang public.

## Mục tiêu sản phẩm

Web app dựng video chạy local, trong đó:

1. AI agent (ví dụ Claude Code) kết nối qua MCP và chỉnh sửa video.
2. Người dùng chỉnh sửa trên cùng timeline đó, trong trình duyệt.

Trường hợp sử dụng chính là dựng cắt ghép video quay bằng iPhone: nói chuyện, tutorial, clip ngắn, kèm phụ đề.

## Kiến trúc

```text
Người dùng (trình duyệt) ── REST/WebSocket ─┐
                                            ├─► CommandEngine ─► Timeline + lịch sử
AI agent ─────────────────── MCP ───────────┘         │
                                                      ├─► Cập nhật trực tiếp lên UI
                                                      └─► FFmpeg: proxy, phân tích, export
```

App không sửa trực tiếp file video. Timeline là JSON, và video chỉ được tạo ra khi preview hoặc export.

| Hạng mục | Lựa chọn |
|---|---|
| Runtime | Node 22.18 trở lên, TypeScript chạy trực tiếp bằng type stripping |
| Schema | Zod |
| Agent | MCP Streamable HTTP tại `/mcp`, stateless |
| Xử lý video | FFmpeg và ffprobe trên PATH, gọi bằng danh sách tham số, không qua shell |
| Test | Vitest, với FFmpeg thật |
| Giao diện | React, Vite, Radix UI, CSS Modules, gọi REST tại `/api` |
| Dự kiến cho Phase 3 | WebSocket. Hiện UI hỏi trạng thái định kỳ để thấy tiến độ job và thay đổi của agent |
| Dự kiến cho Phase 4 | whisper.cpp, model `base` hoặc `small` |

## Cấu trúc thư mục

```text
src/schema.ts          Schema Project, Asset, Clip, Command, HistoryEntry
src/time.ts            Đổi giữa frame, giây, sample, timecode
src/commands.ts        Logic từng lệnh sửa
src/engine.ts          CommandEngine: lô lệnh, revision, undo/redo
src/store.ts           Lưu và mở thư mục project
src/jobs.ts            Hàng đợi job nặng, chạy lần lượt
src/cli.ts             CLI để thử
src/media/probe.ts     Đọc thông tin video
src/media/import.ts    Chuẩn hóa master và tạo proxy
src/media/hdr.ts       LUT chuyển HDR sang SDR
src/media/export.ts    Export và preview
src/media/frames.ts    Trích frame và filmstrip
src/mcp/tools.ts       Công cụ MCP
src/mcp/http.ts        HTTP server, token, kiểm tra Host và Origin
src/media/peaks.ts     Độ lớn âm thanh theo từng frame, cho waveform
src/mcp/workspace.ts   Danh sách project, giới hạn thư mục import, khởi động job
src/api/routes.ts      REST API cho giao diện, dùng chung CommandEngine với MCP
src/api/static.ts      Gửi file có hỗ trợ Range, phục vụ giao diện đã build
web/src/App.tsx        Điều hướng giữa danh sách project và màn hình dựng
web/src/api.ts         Gọi REST API
web/src/projects/      Danh sách project, tạo project
web/src/editor/        Màn hình dựng: Editor, Library, Preview, Timeline, Properties, ExportDialog, Shortcuts
web/src/editor/player.ts       Phát timeline trên hai thẻ video
web/src/editor/timelineOps.ts  Tính toán di chuyển, trim, bám điểm cắt, có unit test
web/src/ui/            Component dùng chung, bọc Radix
web/src/styles/        tokens.css và style nền
scripts/benchmark.ts   Đo hiệu năng trên video thật
test/                  Unit test và test tích hợp
```

Mỗi project là một thư mục:

```text
projects/<id>/
  project.json     Trạng thái hiện tại, là nguồn dữ liệu chính
  history.jsonl    Lịch sử sửa, dùng cho undo
  masters/         Bản chuẩn hóa, chỉ có khi file gốc chưa đạt chuẩn
  proxies/         Bản 720p để xem trước
  cache/           LUT và dữ liệu tạm
  previews/        Kết quả render_preview
  exports/         Kết quả export
```

## Lệnh thường dùng

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm start
```

```bash
npm run mcp
```

```bash
npm run web:dev
```

```bash
npm run benchmark -- <thư mục ra> <video>
```

## Quy ước thời gian

- **Mọi vị trí đều là số nguyên frame** ở fps của project, trên cả timeline lẫn trong nguồn. Không lưu ms hay giây.
- **Fps project cố định khi tạo**, mặc định `30/1`, lưu dạng phân số. Không đổi được sau khi tạo.
- MCP nhận `{frame}` hoặc `{seconds}`, làm tròn về frame và trả lại frame thực tế đã dùng.
- Audio chuẩn hóa về 48 kHz. Số sample tính từ vị trí trên timeline để không tích lũy sai số qua các điểm cắt.
- Khi seek, FFmpeg bắt đầu sớm hơn nửa frame để không mất frame cần lấy do làm tròn, và phần audio tương ứng được cắt bỏ.

## Quy tắc import

File gốc không bao giờ bị sửa. App tạo master khi gặp một trong các trường hợp sau, nếu không thì dùng thẳng file gốc:

| Điều kiện | Ngưỡng |
|---|---|
| Fps khác project | Lệch trên 0,05%, nên 29,97 và 30 được coi là khác nhau |
| Fps không đều | Lệch trên 0,5 frame. Ngưỡng này mới thử trên một ít video thật |
| HDR | Transfer HLG hoặc PQ, chuyển sang SDR BT.709 bằng LUT tự tính |
| Định dạng điểm ảnh | Khác `yuv420p` và `yuvj420p` |
| Audio | Khác 48 kHz |
| Hình và tiếng | Không bắt đầu cùng lúc, lệch trên 1 ms |

Thông tin xoay được FFmpeg áp dụng khi giải mã. Proxy phải có đúng số frame như master, nếu không thì import báo lỗi.

## Quy tắc sửa và cộng tác

- Lô lệnh là nguyên tử: thành công toàn bộ hoặc không đổi gì, và được undo bằng một lần.
- Mỗi lệnh kèm `baseRevision`. Nếu timeline đã đổi, lệnh bị từ chối và bên gửi phải đọc lại.
- Lịch sử ghi rõ `actor` là `user` hay `agent`, kèm mô tả.
- Clip trên cùng một track không được chồng nhau.
- Thêm asset không undo được, để undo không làm mất media.
- Thông báo lỗi phải đủ rõ để người hoặc agent tự sửa, và viết bằng tiếng Việt.

## Bảo mật

- Server chỉ nghe trên `127.0.0.1`, yêu cầu token Bearer, từ chối Host và Origin lạ.
- Chỉ import được file có đuôi video, sau khi đã giải symlink. Mặc định cho phép toàn bộ máy, kể cả với agent có token. `VE_MEDIA_DIRS` giới hạn lại khi cần.
- Tên project và tên file xuất được kiểm tra. File xuất luôn nằm trong thư mục của project.
- Token lưu ở `projects/.mcp-token` với quyền `600`.
- Trình duyệt đăng nhập qua `/?token=...`, server chuyển token vào cookie `HttpOnly`, `SameSite=Strict` rồi xóa khỏi địa chỉ. Thẻ video không gửi được header nên cần cookie. `/api` nhận Bearer hoặc cookie, `/mcp` chỉ nhận Bearer.
- File tĩnh của giao diện không cần token vì không chứa dữ liệu người dùng, và có Content-Security-Policy.

## Môi trường và hiệu năng

Máy phát triển là Mac Intel i5-8279U, 8 GB RAM. Khi cài công cụ, ưu tiên bản binary dựng sẵn cho `darwin-amd64`.

Preview dùng thẻ video trên proxy: chỉ thẳng tới giữa frame khi seek để không lệch do làm tròn, và chuyển clip sớm khoảng 8 ms để frame sau điểm cắt không hiện ra. Âm lượng đi qua Web Audio vì thẻ video không phát to hơn 100%.

Bản FFmpeg đang dùng **không có** `drawtext` và `zscale`. Vì vậy test đọc số frame qua barcode, còn HDR dùng LUT.

| Việc đo trên máy này | Kết quả |
|---|---|
| Tạo master SDR 1080p | Nhanh gấp 2,2 lần thời lượng video |
| Tạo master từ HDR iPhone 1080p | Chậm khoảng 2 lần thời lượng video |
| Tạo proxy | Nhanh gấp 2 đến 4 lần thời lượng video |
| Export 1080p | Nhanh gấp khoảng 1,9 lần thời lượng video |

`libx264` là encoder mặc định. Với video SDR nó nhanh hơn VideoToolbox khoảng 2 lần và file nhỏ hơn 3 lần. VideoToolbox trên máy này không hỗ trợ chế độ chất lượng cố định, nên phải đặt bitrate.

Cài đặt iPhone khuyến nghị: 1080p 30 fps, tắt HDR, tắt FPS tự động. Dưới đèn nhấp nháy do điện 50 Hz thì nên quay cả buổi ở 25 fps. MCP hiện chỉ tạo project 30 fps, nên video 25 fps sẽ bị đổi sang 30 fps cho tới khi có tính năng chọn fps ở Phase 5.

## Rủi ro đang theo dõi

| Rủi ro | Cách xử lý |
|---|---|
| Preview khác bản export | Hiệu ứng phải làm được ở cả hai bên, có test so frame giữa preview và export. Ngay sau điểm cắt, preview có thể bỏ qua 1 đến 2 frame hiển thị, bản export không bị |
| Máy yếu | Dùng proxy, chạy lần lượt từng job nặng |
| Agent sửa sai | Không sửa file gốc, undo theo lô, xem trước khi export |
| Màu HDR | Mới xem một frame từ iPhone thật, chưa so trực tiếp với bản gốc |

## Tiến độ dự án

Trạng thái: `[x]` đã xong và đã kiểm chứng, `[ ]` chưa làm.

### Chuẩn bị

- [x] Thống nhất mục tiêu và kiến trúc
- [x] Thống nhất đơn vị frame và chuẩn hóa fps khi import
- [x] Chọn mặc định 30 fps và cài đặt iPhone
- [x] Dựng mockup giao diện đích
- [x] Tạo repo GitHub và nhánh `phase-0`

### Phase 0: Lõi kỹ thuật

- [x] Schema timeline và tính toán thời gian theo frame
- [x] CommandEngine: lô nguyên tử, revision, undo/redo, ghi người sửa
- [x] Lưu và mở lại project
- [x] Import: probe, master, proxy cùng số frame
- [x] Xử lý fps không đều, video xoay, HDR
- [x] Export khớp từng frame, tiếng lệch dưới 1 frame
- [x] Test với 24, 29,97 và 60 fps trên cùng timeline
- [x] Đo hiệu năng trên video thật, gồm một video iPhone
- [ ] Merge nhánh `phase-0` vào `main`

### Phase 1: Agent kết nối qua MCP

- [x] MCP server qua HTTP, bảo vệ bằng token, Host và Origin
- [x] Công cụ đọc: `list_projects`, `get_timeline`, `get_asset_info`, `get_history`
- [x] Công cụ nhìn: `get_frame`, `get_filmstrip`
- [x] Công cụ sửa, `apply_batch`, `undo`, `redo`
- [x] Job nền: `import_asset`, `render_preview`, `export_video`, `get_job_status`
- [x] Claude Code tự cắt và export một video mẫu, kết quả đúng từng frame
- [ ] Commit, push và merge nhánh `phase-1`

### Phase 2: Giao diện cơ bản

- [x] Khởi tạo React, Vite, design tokens và font theo DESIGN.md
- [x] Chọn thư viện component public và ghi vào DESIGN.md
- [x] REST API dùng chung CommandEngine với MCP
- [x] Danh sách project và tạo project mới
- [x] Thư viện media, import có tiến độ
- [x] Preview từ proxy, phát/dừng, bước từng frame, timecode
- [x] Timeline: thước thời gian, playhead, track video và âm thanh
- [x] Thao tác: kéo thả, trim, cắt, xóa, bám điểm cắt, zoom
- [x] Panel thuộc tính của clip
- [x] Phím tắt, undo/redo
- [x] Hộp thoại xuất video có tiến độ
- [x] Kiểm tra độ lệch giữa preview và export
- [x] Người dùng tự dựng được một video hoàn chỉnh trên web

### Phase 3: Cộng tác người và agent

- [ ] WebSocket đẩy thay đổi tới UI ngay lập tức
- [ ] Xử lý revision cũ trên UI mà không mất thao tác của người dùng
- [ ] Tab Hoạt động: lịch sử theo người sửa
- [ ] Đánh dấu clip agent vừa sửa, thông báo trên timeline
- [ ] Hoàn tác riêng một lô của agent
- [ ] Trạng thái kết nối của agent
- [ ] Agent và người cùng sửa một project mà không mất thay đổi

### Phase 4: Phân tích và sửa thông minh

- [ ] Tích hợp whisper.cpp, `get_transcript`
- [ ] `detect_silence`, `detect_scenes`, `get_loudness`
- [ ] Tab Transcript, bấm để đến đúng thời điểm
- [ ] Sửa video qua transcript
- [ ] Agent làm được yêu cầu như "bỏ hết khoảng lặng và từ thừa"

### Phase 5: Mở rộng

- [ ] Chọn fps khi tạo project qua MCP và UI
- [ ] Nhiều track video và audio riêng
- [ ] Track chữ và phụ đề, xuất được trong video
- [ ] Transition
- [ ] Keyframe
- [ ] Nhiều tỉ lệ khung hình
- [ ] Hủy job đang chạy, giữ trạng thái job sau khi khởi động lại

### Hoàn thành dự án

- [ ] Test với video iPhone SDR quay theo cài đặt khuyến nghị
- [ ] So màu HDR với bản gốc trên nhiều video thật
- [ ] Dựng trọn vẹn một video thật, có cả người và agent cùng sửa
- [ ] Rà soát bảo mật toàn bộ server
- [ ] Rà soát accessibility theo DESIGN.md
- [ ] Hoàn thiện tài liệu cài đặt và sử dụng
- [ ] Phát hành bản 1.0

### Chưa làm trong bản đầu

Nhiều người dùng, đăng nhập, deploy cloud, color grading và hiệu ứng phức tạp.
