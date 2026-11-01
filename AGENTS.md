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
| Cập nhật trực tiếp | WebSocket (`ws`) tại `/api/projects/<id>/events`: toàn bộ trạng thái khi có thay đổi, tiến độ job, trạng thái agent |
| Nhận dạng lời nói | whisper.cpp (`whisper-cli`), ưu tiên model `large-v3-turbo` kèm VAD Silero |

## Cấu trúc thư mục

```text
src/schema.ts          Schema Project, Asset, Clip, Command, HistoryEntry
src/animation.ts       Giá trị của clip tại mỗi frame: keyframe, transition. Preview và export dùng chung
src/time.ts            Đổi giữa frame, giây, sample, timecode
src/commands.ts        Logic từng lệnh sửa
src/engine.ts          CommandEngine: lô lệnh, revision, undo/redo
src/store.ts           Lưu và mở thư mục project
src/jobs.ts            Hàng đợi job nặng, chạy lần lượt
src/cli.ts             CLI để thử
src/media/probe.ts     Đọc thông tin video
src/media/import.ts    Chuẩn hóa master và tạo proxy
src/media/hdr.ts       LUT chuyển HDR sang SDR
src/media/export.ts    Dựng filter graph nhiều lớp, export và preview
src/media/text.ts      Vẽ chữ thành PNG trong suốt, preview và export dùng chung
src/media/frames.ts    Trích frame và filmstrip
src/mcp/tools.ts       Công cụ MCP
src/mcp/http.ts        HTTP server, token, kiểm tra Host và Origin
src/media/peaks.ts     Độ lớn âm thanh theo từng frame, cho waveform
src/media/analyze.ts   Khoảng lặng, điểm đổi cảnh, độ to
src/media/whisper.ts   Tìm whisper, tạo và đọc transcript
src/transcript.ts      Đặt transcript lên timeline, tìm lại từ đã chọn, dùng chung với giao diện
src/mcp/workspace.ts   Danh sách project, giới hạn thư mục import, khởi động job
src/api/routes.ts      REST API cho giao diện, dùng chung CommandEngine với MCP
src/api/events.ts      WebSocket đẩy thay đổi của một project tới giao diện
src/mcp/presence.ts    Trạng thái agent, suy ra từ các yêu cầu MCP gần đây
src/api/static.ts      Gửi file có hỗ trợ Range, phục vụ giao diện đã build
web/src/App.tsx        Điều hướng giữa danh sách project và màn hình dựng
web/src/api.ts         Gọi REST API
web/src/projects/      Danh sách project, tạo project
web/src/editor/        Màn hình dựng: Editor, Library, TranscriptPanel, Preview, Timeline, Properties, Activity, AgentStatusBadge, ExportDialog, Shortcuts
web/src/editor/player.ts       Phát timeline trên hai thẻ video
web/src/editor/timelineOps.ts  Tính toán di chuyển, trim, bám điểm cắt, có unit test
web/src/editor/rebase.ts       Gửi lại thao tác khi gặp revision cũ
web/src/editor/agentNotice.ts  Chọn các thay đổi của agent chưa xem, mô tả thay đổi
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
  transcripts/     Transcript từng video, tính theo frame nguồn
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
- **Fps project chọn khi tạo**, mặc định `30/1`, lưu dạng phân số. Không đổi được sau khi tạo.
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
| Luồng âm thanh đầu | FFmpeg không giải mã được, như APAC của iPhone quay âm thanh không gian. Master dùng luồng đọc được đầu tiên, thường là AAC đi kèm. Nếu không có luồng nào thì video không có tiếng |

Thông tin xoay được FFmpeg áp dụng khi giải mã. Proxy phải có đúng số frame như master, nếu không thì import báo lỗi.

File âm thanh (`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`) được chuyển thành một file AAC 48 kHz, dùng làm cả master lẫn proxy, và asset có `hasVideo: false`.

## Nhiều lớp và hiệu ứng

- Track có ba loại: `video`, `audio`, `text`. Track sau vẽ đè lên track trước. Track video đầu tiên là track chính: transcript và `detect_silence` chỉ đọc track này.
- Khi xóa và dồn, chỉ các track được nêu mới dồn. `delete_ranges` nhận `alsoTrackIds` để phụ đề đi cùng lời nói, còn nhạc thì để yên.
- X, Y là phần khung hình tính từ tâm, thu phóng 1 là cỡ vừa khung. Keyframe tính từ frame đầu của clip, nội suy thẳng và giữ nguyên ở ngoài khoảng. Cắt và trim giữ animation trên đúng hình đó.
- Transition đặt trên clip sau và không đổi độ dài timeline. `crossfade` cho clip trước chạy tiếp sau điểm cắt, nên cần đoạn dư trong nguồn; thiếu thì ngắn lại, không còn thì clip sau chỉ hiện dần. `dip` mờ ra rồi mờ vào quanh điểm cắt. Sửa timeline sau đó không bao giờ làm transition báo lỗi.
- Công thức cho từng frame nằm ở `src/animation.ts`. Khi thêm hiệu ứng, phải làm được ở cả `src/media/export.ts` và `web/src/editor/player.ts`.
- Export ghép mỗi track thành một luồng cỡ khung hình rồi chồng lên nhau. Clip không có hiệu ứng đi đường nhanh như trước. Độ mờ theo frame nhân alpha với một hình xám 2×2 phóng lớn, nhanh hơn nhiều so với `geq` trên cả khung.
- Khung hình đổi được bằng `set_canvas`, lưu cả trong `timeline.canvas` để Hoàn tác lấy lại được.
- Chữ là PNG cỡ khung hình, vẽ bằng `@napi-rs/canvas` và lưu theo nội dung. Preview hiện chính PNG này nên chữ khớp với bản xuất.

## Job

- `cancel_job` hoặc nút Hủy dừng FFmpeg và whisper, rồi xóa file dở.
- Danh sách job lưu ở `projects/.jobs.json`. Sau khi server khởi động lại, job đã xong còn nguyên kết quả, còn job đang dở được báo là thất bại vì bị gián đoạn và phải chạy lại.

## Quy tắc sửa và cộng tác

- Lô lệnh là nguyên tử: thành công toàn bộ hoặc không đổi gì, và được undo bằng một lần.
- Trong một lô, `add_clip` và `split_clip` có thể đặt tên tạm bằng `as`, để lệnh sau dùng làm `clipId`. Tên chỉ có nghĩa trong lô đó, lịch sử lưu id thật và kết quả trả về `aliases`.
- Mỗi lệnh kèm `baseRevision`. Nếu timeline đã đổi, lệnh bị từ chối và bên gửi phải đọc lại.
- Khi UI gặp revision cũ, lô lệnh được gửi lại trên timeline mới nhất, vì lệnh chỉ tới clip theo id. Hoàn tác và Làm lại thì không gửi lại, vì khi đó chúng sẽ tác động lên một thay đổi khác.
- Hoàn tác riêng một lô (`CommandEngine.revert`) giữ các thay đổi sau đó, và được ghi thành một lô mới có `revertsRevision`, nên Hoàn tác thường lấy lại được. Nếu thay đổi sau đã sửa đúng trường mà lô đó đổi, hoặc kết quả bị chồng clip, lệnh bị từ chối và không đổi gì.
- Lịch sử ghi rõ `actor` là `user` hay `agent`, kèm mô tả.
- Clip trên cùng một track không được chồng nhau.
- Thêm asset không undo được, để undo không làm mất media.
- `delete_ranges` xóa nhiều đoạn trong một lệnh. Mọi đoạn đều tính theo timeline trước lệnh đó, nên không phải tự trừ dần. Mảnh đầu của clip giữ id, như khi cắt.
- Thông báo lỗi phải đủ rõ để người hoặc agent tự sửa, và viết bằng tiếng Việt.

## Transcript

- Transcript lưu theo frame nguồn của từng video, không đi qua `CommandEngine` vì nó là kết quả phân tích, không phải sửa timeline. Mọi cách cắt sau đó không làm nó sai.
- Một từ thuộc clip chứa điểm giữa của từ. Giao diện và `get_transcript` đều hiện theo timeline hiện tại.
- Giao diện nhớ từ đã chọn theo vị trí nguồn, nên vẫn xóa đúng khi agent vừa đổi timeline.
- Tìm `whisper-cli` theo `VE_WHISPER_BIN`, PATH rồi `~/.local/bin`. Tìm model theo `VE_WHISPER_MODEL` rồi `~/.local/share/whisper`, và VAD theo `VE_WHISPER_VAD` rồi cùng thư mục đó. Trên máy phát triển, các đường dẫn này là symlink tới bản đã build trong dự án ZoroYoutube.
- Chạy với `-mc 0 -sns --vad` để whisper không lặp câu hay tự nghĩ ra câu trên đoạn không có tiếng, và `-ml 1 -sow` để mỗi từ là một segment. Khi bật VAD, whisper chỉ đổi thời gian của segment về audio gốc, còn thời gian token bỏ qua đoạn lặng, nên chỉ dùng token để tính độ dài từ.
- Token có thể kết thúc giữa một chữ tiếng Việt, nên file JSON được đọc theo byte.

## Bảo mật

- Server chỉ nghe trên `127.0.0.1`, yêu cầu token Bearer, từ chối Host và Origin lạ.
- Chỉ import được file có đuôi video, sau khi đã giải symlink. Mặc định cho phép toàn bộ máy, kể cả với agent có token. `VE_MEDIA_DIRS` giới hạn lại khi cần.
- Tên project và tên file xuất được kiểm tra. File xuất luôn nằm trong thư mục của project.
- Token lưu ở `projects/.mcp-token` với quyền `600`.
- Trình duyệt đăng nhập qua `/?token=...`, server chuyển token vào cookie `HttpOnly`, `SameSite=Strict` rồi xóa khỏi địa chỉ. Thẻ video không gửi được header nên cần cookie. `/api` nhận Bearer hoặc cookie, `/mcp` chỉ nhận Bearer.
- WebSocket kiểm tra token, Host và Origin như `/api`, trước khi nâng cấp kết nối. Trang web lạ không dùng được cookie vì bị chặn ở Origin.
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
| Lớp 1080p có độ mờ và thu phóng đổi theo frame | Nhanh gấp khoảng 1,6 lần thời lượng, đo trên nguồn tổng hợp |
| Transcript, `large-v3-turbo` kèm VAD | 30 giây video mất khoảng 47 giây. Với video dài, dự án ZoroYoutube ghi nhận khoảng 7 phút cho 10 phút video |

`libx264` là encoder mặc định. Với video SDR nó nhanh hơn VideoToolbox khoảng 2 lần và file nhỏ hơn 3 lần. VideoToolbox trên máy này không hỗ trợ chế độ chất lượng cố định, nên phải đặt bitrate.

Cài đặt iPhone khuyến nghị: 1080p 30 fps, tắt HDR, tắt FPS tự động. Dưới đèn nhấp nháy do điện 50 Hz thì nên quay cả buổi ở 25 fps và tạo project 25 fps.

## Rủi ro đang theo dõi

| Rủi ro | Cách xử lý |
|---|---|
| Preview khác bản export | Hiệu ứng phải làm được ở cả hai bên, có test so frame giữa preview và export. Ngay sau điểm cắt, preview có thể bỏ qua 1 đến 2 frame hiển thị, bản export không bị |
| Agent sửa khi người dùng đang phát | Timeline đổi thì preview dừng lại để không phát sai, người dùng phải bấm phát lại |
| Trạng thái agent là suy đoán | MCP không giữ kết nối, nên "đã kết nối" nghĩa là có yêu cầu trong 10 phút gần nhất |
| Máy yếu | Dùng proxy, chạy lần lượt từng job nặng |
| Agent sửa sai | Không sửa file gốc, undo theo lô, xem trước khi export |
| Thời gian từng từ | Whisper lệch vài phần mười giây, nhất là ở từ ngay sau đoạn VAD bỏ qua. Phải nghe lại trước khi xuất. Agent được nhắc trong hướng dẫn MCP |
| Whisper bỏ sót từ thừa | Whisper hay bỏ các tiếng như "ờ", "ừm", nên `possibleFillers` không đủ. Chưa có cách phát hiện từ âm thanh |
| Không thấy khoảng lặng | Video quay ngoài đường có tiếng nền to hơn -35 dB, nên `detect_silence` không thấy gì. Agent nâng `noiseDb` lên, nhưng chưa có mức tự chọn theo từng video |
| Nhiều lớp khi xem trước | Mỗi lớp là một thẻ video riêng và được kéo lại khi lệch quá 0,1 giây, nên có thể lệch vài frame so với track chính lúc phát. Chưa đo trên video thật nhiều lớp. Bản xuất không bị |
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

- [x] WebSocket đẩy thay đổi tới UI ngay lập tức
- [x] Xử lý revision cũ trên UI mà không mất thao tác của người dùng
- [x] Tab Hoạt động: lịch sử theo người sửa
- [x] Đánh dấu clip agent vừa sửa, thông báo trên timeline
- [x] Hoàn tác riêng một lô của agent
- [x] Trạng thái kết nối của agent
- [x] Agent và người cùng sửa một project mà không mất thay đổi

### Phase 4: Phân tích và sửa thông minh

- [x] Tích hợp whisper.cpp, `get_transcript`
- [x] `detect_silence`, `detect_scenes`, `get_loudness`
- [x] Tab Transcript, bấm để đến đúng thời điểm
- [x] Sửa video qua transcript
- [ ] Agent làm được yêu cầu như "bỏ hết khoảng lặng và từ thừa"

### Phase 5: Mở rộng

- [x] Chọn fps khi tạo project qua MCP và UI
- [x] Nhiều track video và audio riêng
- [x] Track chữ và phụ đề, xuất được trong video
- [x] Transition
- [x] Keyframe
- [x] Nhiều tỉ lệ khung hình
- [x] Hủy job đang chạy, giữ trạng thái job sau khi khởi động lại

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
