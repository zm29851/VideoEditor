import { describe, expect, it } from "vitest";
import { formatSize, groupByWarning, importOrder, rangeBetween, selectAllState } from "./importSelection.ts";

const files = ["a", "b", "c", "d"].map((path) => ({ path }));

describe("rangeBetween", () => {
  it("covers both ends in either direction", () => {
    expect(rangeBetween(files, "b", "d").map((file) => file.path)).toEqual(["b", "c", "d"]);
    expect(rangeBetween(files, "d", "b").map((file) => file.path)).toEqual(["b", "c", "d"]);
  });

  it("falls back to the clicked file when the last click was in another folder", () => {
    expect(rangeBetween(files, "o-thu-muc-khac", "c").map((file) => file.path)).toEqual(["c"]);
    expect(rangeBetween(files, undefined, "c").map((file) => file.path)).toEqual(["c"]);
  });

  it("gives nothing for a file that is not on screen", () => {
    expect(rangeBetween(files, "a", "z")).toEqual([]);
  });
});

describe("selectAllState", () => {
  it("only looks at the files it covers", () => {
    expect(selectAllState(files, new Map([["khac", 1]]))).toBe(false);
    expect(selectAllState(files, new Map([["a", 1]]))).toBe("indeterminate");
    expect(selectAllState(files, new Map([...files.map((file) => [file.path, 1] as const), ["khac", 1]]))).toBe(true);
    expect(selectAllState([], new Map())).toBe(false);
  });
});

describe("importOrder", () => {
  it("sorts numbers in file names as numbers", () => {
    const order = importOrder([{ path: "/v/10.mov" }, { path: "/v/2.mov" }, { path: "/a/9.mov" }]);
    expect(order.map((file) => file.path)).toEqual(["/a/9.mov", "/v/2.mov", "/v/10.mov"]);
  });
});

describe("formatSize", () => {
  it("switches to GB past 1024 MB", () => {
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe("1,5 GB");
  });
});

describe("groupByWarning", () => {
  it("says a shared warning once and skips files without one", () => {
    const groups = groupByWarning([{ warning: "x" }, {}, { warning: "y" }, { warning: "x" }]);
    expect(groups.map((group) => [group.warning, group.files.length])).toEqual([["x", 2], ["y", 1]]);
  });
});
