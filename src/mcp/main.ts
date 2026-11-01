import { resolve } from "node:path";
import { loadOrCreateToken, startMcpHttpServer } from "./http.ts";
import { Workspace, defaultMediaDirs } from "./workspace.ts";

const root = resolve(process.env.VE_PROJECTS_DIR ?? "projects");
const port = Number(process.env.VE_MCP_PORT ?? 8765);
const mediaDirs = process.env.VE_MEDIA_DIRS?.split(":").filter(Boolean) ?? defaultMediaDirs();

const workspace = new Workspace(root, mediaDirs);
const token = process.env.VE_MCP_TOKEN ?? loadOrCreateToken(workspace.root);
const { url } = await startMcpHttpServer(workspace, token, port);

console.log(`Video Editor MCP đang chạy tại ${url}`);
console.log(`Project: ${workspace.root}`);
console.log(`Thư mục video được phép: ${workspace.mediaDirs.join(", ")}`);
console.log(`\nKết nối Claude Code, chạy một lần:\n`);
console.log(`claude mcp add --transport http video-editor ${url} --header "Authorization: Bearer ${token}"`);
