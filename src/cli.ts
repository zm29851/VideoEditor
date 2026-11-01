import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importVideo } from "./media/import.ts";
import { exportProject } from "./media/export.ts";
import { createProjectFolder, openProjectFolder } from "./store.ts";

const USAGE = `Cách dùng:
  npm run cli -- create <thư mục project> [--name tên] [--size 1920x1080]
  npm run cli -- import <thư mục project> <file video>
  npm run cli -- apply  <thư mục project> <file lệnh .json>
  npm run cli -- undo   <thư mục project>
  npm run cli -- show   <thư mục project>
  npm run cli -- export <thư mục project> <file ra .mp4>`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, rawRoot, target, ...rest] = process.argv.slice(2);
  if (!command || !rawRoot) throw new Error(USAGE);
  const root = resolve(rawRoot);

  switch (command) {
    case "create": {
      const args = [target ?? "", ...rest];
      const [width, height] = (option(args, "--size") ?? "1920x1080").split("x").map(Number);
      createProjectFolder(root, { name: option(args, "--name") ?? "Project", width, height });
      console.log(`Đã tạo project tại ${root}`);
      return;
    }
    case "import": {
      if (!target) throw new Error(USAGE);
      const engine = openProjectFolder(root);
      const { asset, timings } = await importVideo(root, resolve(target), engine.project.fps);
      engine.registerAsset(asset);
      console.log(JSON.stringify({ asset, timings }, null, 2));
      return;
    }
    case "apply": {
      if (!target) throw new Error(USAGE);
      const engine = openProjectFolder(root);
      const commands = JSON.parse(readFileSync(resolve(target), "utf8"));
      const result = engine.applyBatch({
        actor: "user",
        baseRevision: engine.project.revision,
        label: "Lệnh từ CLI",
        commands,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "undo": {
      const engine = openProjectFolder(root);
      console.log(JSON.stringify(engine.undo("user", engine.project.revision), null, 2));
      return;
    }
    case "show": {
      console.log(JSON.stringify(openProjectFolder(root).project, null, 2));
      return;
    }
    case "export": {
      if (!target) throw new Error(USAGE);
      await exportProject(openProjectFolder(root).project, resolve(target));
      console.log(`Đã xuất ${resolve(target)}`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
