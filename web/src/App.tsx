import { useEffect, useSyncExternalStore } from "react";
import { Editor } from "./editor/Editor.tsx";
import { ProjectList } from "./projects/ProjectList.tsx";
import { UiProvider } from "./ui/ui.tsx";

function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function App() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const projectId = /^#\/p\/(.+)$/.exec(hash)?.[1];

  useEffect(() => {
    if (!projectId) document.title = "Video Editor";
  }, [projectId]);

  return (
    <UiProvider>
      {projectId ? <Editor key={projectId} projectId={decodeURIComponent(projectId)} /> : <ProjectList />}
    </UiProvider>
  );
}
