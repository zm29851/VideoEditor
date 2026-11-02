/** What choosing several files needs to know, kept apart from the dialog so it can be tested. */

export interface ImportCandidate {
  path: string;
  name: string;
  sizeBytes?: number;
}

/** Files between the last one clicked and this one, both included, in the order on screen. */
export function rangeBetween<T extends { path: string }>(files: T[], anchor: string | undefined, target: string): T[] {
  const end = files.findIndex((file) => file.path === target);
  if (end === -1) return [];
  const start = files.findIndex((file) => file.path === anchor);
  if (start === -1) return [files[end]!];
  return files.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** The state of a "select all" box over the files it covers. */
export function selectAllState(covered: Array<{ path: string }>, selected: ReadonlyMap<string, unknown>): boolean | "indeterminate" {
  const count = covered.filter((file) => selected.has(file.path)).length;
  if (count === 0) return false;
  return count === covered.length ? true : "indeterminate";
}

/** File name order, so 2.mov comes before 10.mov, whatever order they were clicked in. */
export function importOrder<T extends { path: string }>(files: Iterable<T>): T[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function formatSize(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(0)} MB`;
  return `${(megabytes / 1024).toFixed(1).replace(".", ",")} GB`;
}

/** Many files often share one warning, so it is said once with the files under it. */
export function groupByWarning<T extends { warning?: string | undefined }>(checks: T[]): Array<{ warning: string; files: T[] }> {
  const groups = new Map<string, T[]>();
  for (const check of checks) {
    if (check.warning) groups.set(check.warning, [...(groups.get(check.warning) ?? []), check]);
  }
  return [...groups].map(([warning, files]) => ({ warning, files }));
}
