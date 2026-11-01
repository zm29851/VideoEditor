# Video Editor

Web app dựng video mà cả người và AI agent cùng sửa trên một timeline. Hiện đang ở Phase 0: lõi dữ liệu và xử lý video, chưa có UI và MCP.

Yêu cầu: Node 22.18 trở lên, `ffmpeg` và `ffprobe` trên PATH.

```bash
npm install
```

```bash
npm test
```

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
