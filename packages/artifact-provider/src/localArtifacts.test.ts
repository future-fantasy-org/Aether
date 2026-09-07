import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalArtifactProvider } from "./localArtifacts.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aether-art-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalArtifactProvider", () => {
  it("saves, lists, reads and exports artifacts", async () => {
    const p = new LocalArtifactProvider(root);
    const saved = await p.save("th_1", { type: "markdown", title: "Report.md", metadata: {}, content: "# hi" });
    expect(saved.type).toBe("markdown");
    expect(saved.location.kind).toBe("local");

    const list = await p.list("th_1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.id);

    const read = await p.read(saved.id);
    expect(read?.content).toBe("# hi");

    const dest = path.join(root, "export", "Report.md");
    const exported = await p.export(saved.id, dest);
    expect(exported.location).toEqual({ kind: "local", path: dest });

    // fresh provider reads from disk (persistence works)
    const p2 = new LocalArtifactProvider(root);
    const list2 = await p2.list("th_1");
    expect(list2).toHaveLength(1);
  });

  it("returns empty list for unknown thread", async () => {
    const p = new LocalArtifactProvider(root);
    expect(await p.list("th_none")).toEqual([]);
  });

  it("sanitizes thread ids in paths", async () => {
    const p = new LocalArtifactProvider(root);
    const saved = await p.save("../../evil", { type: "text", title: "x.txt", metadata: {}, content: "x" });
    expect(saved.location.path).not.toContain("..");
  });
});
