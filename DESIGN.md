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
}
```

Cần giá trị mới thì thêm biến vào `tokens.css`, không viết trực tiếp trong component.

## 3. Chữ

- Dùng duy nhất Be Vietnam Pro, ở ba độ đậm 400, 500 và 600.
- Cỡ chữ tối thiểu là 12px. Nội dung chính dùng 14px.
- Timecode và các con số thay đổi liên tục dùng `font-variant-numeric: tabular-nums` để chữ không bị nhảy. Phải kiểm tra font thực sự hỗ trợ tính năng này khi triển khai.
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
- Tab Hoạt động ghi rõ từng thay đổi do ai thực hiện.
- Không chỉ dựa vào màu: luôn kèm chữ hoặc biểu tượng.

### Trạng thái

- Thư viện hiển thị trạng thái xử lý và tiến độ của từng video.
- Trước khi đổi fps, phải cảnh báo nếu video có thể bị giật.
- Việc lâu phải có tiến độ và không chặn thao tác khác.
- Thông báo lỗi nói rõ chuyện gì đã xảy ra và cách xử lý.
- Thiết kế đủ các trạng thái: rỗng, đang tải, lỗi, không có quyền thao tác.

### Hành động

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

## 7. Thư viện component

Danh sách này được chốt khi bắt đầu Phase 2. Bất kỳ thư viện nào được chọn đều phải tùy biến được bằng CSS và biến ở mục 2, để không trái mục 1.

| Nhu cầu | Thư viện đề xuất | Trạng thái |
|---|---|---|
| Tab, dialog, menu, slider, tooltip, select | Radix UI Primitives | Chờ chốt |
| Biểu tượng | Lucide | Chờ chốt |
| Font | `@fontsource` cho Be Vietnam Pro, để chạy được khi không có mạng | Chờ chốt |
| Style | CSS Modules kèm `tokens.css` | Chờ chốt |
| Waveform | Đánh giá wavesurfer.js trước khi tự vẽ | Chờ đánh giá |
| Timeline | Đánh giá thư viện public trước khi tự viết | Chờ đánh giá |

### Component tự viết

Chưa có. Khi thêm, ghi tên component, các thư viện đã xem xét và lý do không dùng được.

## 8. Accessibility

- Dùng thẻ đúng ngữ nghĩa, như `<button>` và `<label>`. Nút chỉ có biểu tượng phải có `aria-label`.
- Mọi thao tác dùng được bằng bàn phím, và có viền focus rõ ràng.
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
