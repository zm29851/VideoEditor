# DESIGN.md

Quy định UI/UX của dự án. **Phải đọc lại toàn bộ file này trước mỗi lần tạo mới hoặc chỉnh sửa giao diện.** Khi có quy định mới, cập nhật file này trước rồi mới làm giao diện.

Mockup tham khảo bố cục: [Giao diện Video Editor](https://claude.ai/artifact/96GW2TxyEJzQDyyUkuSTrU). Mockup được làm trước khi có các quy tắc ở mục 1, nên nó dùng font khác và style in-line. Khi hai bên khác nhau, file này được ưu tiên.

## 1. Năm quy tắc nền tảng

1. **Dùng tối đa component public.** Trước khi tự viết một component, phải tìm thư viện public phù hợp. Chỉ tự viết khi không có lựa chọn đạt yêu cầu, và ghi lý do vào mục 7.
2. **Không dùng style in-line.** Mọi style nằm trong file CSS.
3. **Màu sắc, border radius và shadow phải dùng biến.** Không viết trực tiếp giá trị trong CSS của component.
4. **Font là Be Vietnam Pro** cho toàn bộ giao diện.
5. **Ưu tiên không gian thở.** Khi phân vân, chọn khoảng cách rộng hơn và bớt thông tin trên màn hình.

### Ngoại lệ về style in-line

Vị trí và độ rộng trên timeline, playhead, tiến độ thay đổi theo dữ liệu nên không viết sẵn được trong CSS. Với các giá trị này, JavaScript chỉ được gán **biến CSS**, còn CSS đọc biến đó để áp dụng:

```tsx
ref.current.style.setProperty("--clip-left", `${left}px`);
```

```css
.clip { left: var(--clip-left); }
```

Không dùng thuộc tính `style={{ ... }}` trong JSX, kể cả cho trường hợp này.

## 2. Biến thiết kế

Tất cả biến nằm trong một file duy nhất, `tokens.css`. Giao diện dùng nền tối để màu video hiển thị chính xác.

```css
:root {
  /* Nền */
  --color-bg-app: #101214;
  --color-bg-panel: #15171a;
  --color-bg-raised: #1d2025;
  --color-bg-control: #20242a;

  /* Viền */
  --color-border: #2b3036;
  --color-border-strong: #434a53;

  /* Chữ */
  --color-text: #e8eaed;
  --color-text-muted: #a2a8b0;

  /* Người dùng và hành động chính */
  --color-primary: #7db8ff;
  --color-primary-hover: #a9d0ff;
  --color-on-primary: #0d1721;

  /* AI agent */
  --color-agent: #f5a25d;
  --color-on-agent: #21150a;
  --color-agent-surface: #2a2018;
  --color-agent-border: #5a3f26;

  /* Trạng thái */
  --color-success: #7fcba4;
  --color-danger: #ff9d9d;
  --color-danger-surface: #2c1a1c;

  /* Lớp phủ và nền video */
  --color-overlay: rgb(0 0 0 / 0.6);
  --color-preview-bg: #000000;

  /* Timeline */
  --color-clip-video: #2a3a4d;
  --color-clip-video-border: #465c75;
  --color-clip-audio: #1f3029;
  --color-clip-audio-border: #35524a;
  --color-waveform: #7fcba4;
  --color-clip-text: #3a2f4f;
  --color-clip-text-border: #6f5c94;
  --color-playhead: #ffffff;

  /* Bo góc */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 999px;

  /* Đổ bóng */
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.3);
  --shadow-md: 0 4px 12px rgb(0 0 0 / 0.35);
  --shadow-lg: 0 12px 32px rgb(0 0 0 / 0.45);

  /* Khoảng cách */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;

  /* Chữ */
  --font-family: "Be Vietnam Pro", system-ui, sans-serif;
  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 16px;
  --font-size-xl: 20px;
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;

  /* Kích thước bố cục */
  --size-control-sm: 28px;
  --size-control: 36px;
  --size-control-lg: 44px;
  --size-header: 56px;
  --size-panel-left: 280px;
  --size-panel-right: 300px;
  --size-timeline: 300px;
  --size-ruler: 28px;
  --size-track: 56px;
  --size-track-audio: 40px;
  --size-track-label: 112px;
  --size-trim-handle: 8px;
  --size-thumb-width: 72px;
  --size-thumb-height: 44px;
}
```

Cần giá trị mới thì thêm biến vào `tokens.css`, không viết trực tiếp trong component.

## 3. Chữ

- Dùng duy nhất Be Vietnam Pro, ở ba độ đậm 400, 500 và 600.
- Cỡ chữ tối thiểu là 12px. Nội dung chính dùng 14px.
- Be Vietnam Pro **không có** `tabular-nums`: đã đo trên trình duyệt, số 1 rộng 0,39em còn số 4 rộng 0,71em dù bật tính năng này. Vì vậy timecode và các con số thay đổi liên tục dùng component `Digits`, đặt mỗi chữ số vào một ô rộng cố định để chữ không bị nhảy.
- Toàn bộ nội dung giao diện viết bằng tiếng Việt, câu ngắn, dùng đúng thuật ngữ đã thống nhất ở mục 6.

## 4. Không gian thở

- Mọi khoảng cách dùng biến `--space-*`.
- Nội dung trong panel cách viền ít nhất `--space-4`. Hai nhóm nội dung khác nhau cách nhau ít nhất `--space-5`.
- Ưu tiên tách nhóm bằng khoảng trống, chỉ dùng đường kẻ khi khoảng trống là chưa đủ.
- Mỗi vùng chỉ hiện thông tin cần cho việc đang làm. Thông tin phụ đưa vào tab, panel hoặc tooltip.
- Không lồng khung trong khung.
- Vùng preview là trọng tâm và phải được ưu tiên diện tích khi cửa sổ nhỏ lại.

## 5. Bố cục và tương tác đã thống nhất

### Bố cục màn hình dựng video

| Vùng | Nội dung |
|---|---|
| Thanh trên cùng | Tên project, thông số video, undo/redo, trạng thái agent, nút Xuất video |
| Bên trái | Tab Thư viện và tab Transcript |
| Giữa | Preview, timecode `giờ:phút:giây:frame`, phát/dừng, bước từng frame |
| Bên phải | Tab Thuộc tính và tab Hoạt động |
| Dưới cùng | Công cụ timeline, thước thời gian, các track, playhead |

### Phân biệt người và AI

- **Màu xanh dương là của người dùng, màu cam là của agent.** Hai màu này không dùng cho mục đích khác.
- Clip agent vừa sửa có viền cam.
- Sau khi agent sửa, một dải thông báo trên timeline nói rõ đã đổi gì và có nút hoàn tác cả lô đó.
- Dải thông báo gộp các lô agent sửa mà người dùng chưa xem, hiện lô mới nhất và số lô còn lại. Viền cam giữ tới khi bấm "Đã xem", và lần sau mở project vẫn còn nếu chưa xem.
- Tab Hoạt động ghi rõ từng thay đổi do ai thực hiện, và lô của agent còn hiệu lực có nút hoàn tác riêng.
- Hoàn tác riêng một lô giữ nguyên các thay đổi sau đó. Nếu một thay đổi sau đã sửa cùng clip thì báo rõ và không đổi gì.
- Thanh trên cùng hiện trạng thái agent: đang làm việc, đã kết nối, không hoạt động hoặc chưa có. Nếu mất kết nối tới server thì hiện thông báo này thay cho trạng thái agent.
- Thao tác của người dùng gặp revision cũ sẽ tự gửi lại trên timeline mới nhất. Chỉ báo lỗi khi không thể áp dụng được nữa. Riêng Hoàn tác và Làm lại không tự gửi lại, vì khi đó chúng sẽ tác động lên một thay đổi khác.
- Không chỉ dựa vào màu: luôn kèm chữ hoặc biểu tượng.

### Trạng thái

- Thư viện hiển thị trạng thái xử lý và tiến độ của từng video.
- Tạo transcript chỉ chạy khi người dùng hoặc agent yêu cầu, vì mất nhiều thời gian. Tab Transcript hiện tiến độ của từng video.
- Trước khi đổi fps, phải cảnh báo nếu video có thể bị giật.
- Việc lâu phải có tiến độ và không chặn thao tác khác.
- Thông báo lỗi nói rõ chuyện gì đã xảy ra và cách xử lý.
- Thiết kế đủ các trạng thái: rỗng, đang tải, lỗi, không có quyền thao tác.

### Transcript

- Tab Transcript hiện lời nói đúng theo timeline hiện tại: phần đã cắt không còn trong danh sách.
- Bấm một từ để đưa playhead tới đó và chọn từ đó. Shift và bấm để chọn cả đoạn. Khi đang phát, từ đang nói có gạch chân.
- Bàn phím: mũi tên trái, phải đi giữa các từ, thêm Shift để chọn, Enter để đến từ đó, Delete để xóa và dồn đoạn đã chọn, Esc để bỏ chọn.
- Từ có thể là từ thừa có gạch chân chấm kèm tooltip. Đây chỉ là gợi ý, không tự xóa.
- Xóa từ là một thao tác sửa bình thường: thành một lô trong Hoạt động và Hoàn tác được.

### Nhiều track

- Track sau vẽ đè lên track trước. Timeline hiện track trên cùng ở trên cùng, nhãn track nằm bên trái.
- Chỉ track video đầu tiên có hàng tiếng riêng, vì đây là nơi có lời nói. Transcript và phụ đề đọc từ track này.
- Kéo clip lên, xuống để đổi track. Phím thay thế là ⌥↑ và ⌥↓. Clip chỉ vào được track phát được nó: video vào track video, âm thanh vào track âm thanh, chữ vào track chữ.
- Bản xem trước hiện đúng các lớp, vị trí, độ mờ và transition như bản xuất. Chữ trên preview dùng chính hình mà bản xuất vẽ.

### Thuộc tính của clip

- X, Y tính bằng phần trăm khung hình, từ tâm. Thu phóng 100% là cỡ vừa khung.
- Mỗi thuộc tính có thể đổi theo thời gian có nút hình thoi: bấm để đặt hoặc bỏ keyframe tại playhead. Khi đã có keyframe, kéo thanh trượt sẽ đặt keyframe tại playhead.
- Transition nằm trên clip phía sau của điểm cắt và không đổi độ dài timeline. Nếu không đủ đoạn dư để hòa tan thì nói rõ là clip chỉ hiện dần.
- Khi chưa chọn clip, panel Thuộc tính cho đổi khung hình của project.

### Kéo dài clip

- Kéo cạnh clip ra ngoài mà chạm clip bên cạnh thì không bị chặn: các clip phía sau được đẩy lùi vừa đủ, khoảng trống có sẵn được dùng trước. Khi đang kéo, timeline hiện vị trí mới của các clip bị đẩy.
- Kéo đầu clip ra sớm hơn clip trước thì clip giữ nguyên chỗ bắt đầu, phần thêm làm clip dài về phía sau.
- Giới hạn duy nhất là đoạn còn lại trong video nguồn.
- Clip trên track video đầu tiên đẩy cả track chữ để phụ đề đi cùng lời nói. Nhạc và các track video khác giữ nguyên.
- Phím thay thế là ⌥[ và ⌥]: kéo dài đầu hoặc cuối clip đang chọn thêm một frame.

### Thư mục project

- Hộp thoại Project mới có mục Thư mục project, mặc định là nơi lưu của app. Bấm Chọn thư mục để duyệt và bấm Dùng thư mục này. Giao diện chỉ chọn được thư mục đã có.
- Danh sách project hiện đường dẫn thư mục dưới tên project.
- Hộp thoại thêm video luôn mở sẵn thư mục project. Nếu thư mục nằm ngoài phạm vi được phép thì mở danh sách thư mục.

### Thêm nhiều file

- Trong hộp thoại thêm video, bấm dòng file là chọn hoặc bỏ chọn, Shift và bấm để chọn cả đoạn, có ô Chọn tất cả cho thư mục đang xem. Bấm thư mục là mở thư mục. Chuyển thư mục không mất các file đã chọn.
- File đã có trong Thư viện hoặc đang import được ghi rõ và không nằm trong Chọn tất cả, nhưng vẫn chọn tay được.
- Bấm Thêm thì kiểm tra hết các file trước, có tiến độ. Nếu không có gì cần xem thì import luôn. Có cảnh báo hoặc file không đọc được thì hiện một màn hình gộp, không hỏi từng file. File không đọc được luôn bị bỏ qua.
- Trong Thư viện, các file đang chờ gộp thành một dòng có nút Hủy tất cả. File đang chạy và file lỗi có dòng riêng.

### Hành động

- Việc đang chạy có nút Hủy. Hủy xong không để lại file dở.
- Thao tác sửa được undo nên không cần hỏi xác nhận. Chỉ hỏi với việc không hoàn tác được.
- Mọi thao tác chính trên timeline phải có phím tắt.

## 6. Thuật ngữ

| Dùng | Ý nghĩa |
|---|---|
| Thư viện | Danh sách video đã import |
| Clip | Một đoạn trên timeline |
| Cắt | Chia một clip làm hai |
| Hoàn tác, Làm lại | Undo, Redo |
| Xuất video | Export |
| Bám điểm cắt | Snap |
| Hoạt động | Lịch sử thay đổi |
| Lô | Một nhóm thay đổi được áp dụng và hoàn tác cùng nhau |
| Xóa và dồn | Xóa clip rồi kéo các clip phía sau lên |
| Khung hình | Kích thước và tỉ lệ của video |
| Hòa tan, Mờ qua đen | Hai loại transition |
| Vừa khung, Lấp đầy khung | Hiện cả hình, hoặc phủ kín khung và cắt phần thừa |

## 7. Thư viện component

Danh sách này được chốt khi bắt đầu Phase 2. Bất kỳ thư viện nào được chọn đều phải tùy biến được bằng CSS và biến ở mục 2, để không trái mục 1.

| Nhu cầu | Thư viện | Trạng thái |
|---|---|---|
| Dialog, slider, tooltip, toast, progress, tabs, select, checkbox | Radix UI Primitives (`radix-ui`) | Đã chốt |
| Biểu tượng | `lucide-react` | Đã chốt |
| Font | `@fontsource/be-vietnam-pro`, chạy được khi không có mạng | Đã chốt |
| Style | CSS Modules kèm `tokens.css` | Đã chốt |
| Waveform | `wavesurfer.js`, vẽ từ peaks do server tính | Đã chốt |
| Timeline | Tự viết, xem bên dưới | Đã chốt |

### Component tự viết

**Timeline** (`web/src/editor/Timeline.tsx`). Đã xem xét `@xzdarcy/react-timeline-editor`. Không dùng được vì:

- Mọi vị trí là giây dạng số thực, trong khi dự án yêu cầu số nguyên frame.
- Clip không nhận focus, mã nguồn không có `tabIndex`, `aria-*` hay xử lý phím, trái mục 8.
- Mỗi action chỉ thuộc một hàng, nên không biểu diễn được một clip có cả hàng hình và hàng tiếng đi cùng nhau.

Timeline tự viết dùng Pointer Events và biến CSS, phần tính toán nằm riêng trong `timelineOps.ts` để có unit test.

**Preview** (`web/src/editor/player.ts`). Player public như Video.js phát một nguồn. Dự án cần phát nhiều clip nối nhau theo đúng frame của timeline, nên dùng hai thẻ `<video>` thay phiên, thẻ chờ được seek sẵn tới clip kế tiếp. Các track khác và đoạn dư của transition chạy trên thẻ `<video>` riêng, tạo khi cần và bám theo playhead của track chính.

**Chữ trong video** (`src/media/text.ts`). FFmpeg đang dùng không có `drawtext`, nên server vẽ chữ thành PNG bằng `@napi-rs/canvas` với font Be Vietnam Pro. Preview và bản xuất dùng chung PNG này.

## 8. Accessibility

- Dùng thẻ đúng ngữ nghĩa, như `<button>` và `<label>`. Nút chỉ có biểu tượng phải có `aria-label`.
- Mọi thao tác dùng được bằng bàn phím, và có viền focus rõ ràng.
- Thao tác kéo thả trên timeline phải có phím tắt thay thế.
- Tương phản chữ tối thiểu 4.5:1, kể cả chữ 12px màu phụ.
- Hai màu cần phân biệt phải khác nhau cả về độ sáng, không chỉ khác sắc độ.

## 9. Kiểm tra trước khi hoàn tất

- [ ] Đã đọc lại DESIGN.md trước khi làm
- [ ] Đã tìm component public trước khi tự viết
- [ ] Không có `style=` trong JSX, ngoài việc gán biến CSS theo ngoại lệ ở mục 1
- [ ] Không có mã màu, radius hay shadow viết trực tiếp ngoài `tokens.css`
- [ ] Toàn bộ chữ dùng Be Vietnam Pro và hiển thị đúng dấu tiếng Việt
- [ ] Khoảng cách dùng biến `--space-*`, bố cục không bị chật
- [ ] Có đủ trạng thái rỗng, đang tải và lỗi
- [ ] Đạt yêu cầu ở mục 8
