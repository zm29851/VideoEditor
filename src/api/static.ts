import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
};

// Radix and wavesurfer.js set style attributes and inject style elements from their own code.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export interface SendFileOptions {
  /** Offered as a download under this name. */
  downloadName?: string;
  cacheControl?: string;
}

/** Sends a file with Range support, which the video element needs in order to seek. */
export function sendFile(req: IncomingMessage, res: ServerResponse, path: string, options: SendFileOptions = {}): void {
  const { size } = statSync(path);
  res.setHeader("content-type", CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", options.cacheControl ?? "no-cache");
  if (options.downloadName) {
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`);
  }

  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(size - Number(range[2]), 0);
    }
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("content-length", size === 0 ? 0 : end - start + 1);

  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Serves the built web app. Its files hold no user data, so they need no token. */
export function serveWebApp(req: IncomingMessage, res: ServerResponse, webRoot: string, pathname: string): void {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
  const path = normalize(join(webRoot, relative));
  if (!path.startsWith(webRoot + sep) || !existsSync(path) || !statSync(path).isFile()) {
    if (pathname === "/") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Giao diện chưa được build. Hãy chạy: npm run web:build\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Không tìm thấy trang này.\n");
    return;
  }
  res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  res.setHeader("referrer-policy", "no-referrer");
  // Vite puts a content hash in every asset name, so those can be cached for good.
  sendFile(req, res, path, relative.startsWith("assets/") ? { cacheControl: "public, max-age=31536000, immutable" } : {});
}
