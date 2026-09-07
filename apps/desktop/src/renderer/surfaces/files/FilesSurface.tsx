import { useEffect, useState } from "react";
import { runtimeClient, app } from "../../api/client.js";
import type { FileEntry } from "@aether/agent-runtime-client";

/** Workspace file tree + viewer/editor via the WorkspaceFileProvider. */
export default function FilesSurface({ workspaceId }: { workspaceId: string }) {
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | undefined>();
  const [content, setContent] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();

  const refresh = async (d: string) => {
    try {
      const res = await runtimeClient.fsList(workspaceId, d);
      setEntries(res.entries);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (workspaceId) void refresh(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, dir]);

  const open = async (entry: FileEntry) => {
    if (entry.kind === "directory") {
      setDir(entry.path);
      return;
    }
    setSelected(entry);
    setEditing(false);
    try {
      const res = await runtimeClient.fsRead(workspaceId, entry.path);
      setContent(res.content.content);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async () => {
    if (!selected) return;
    await runtimeClient.fsWrite(workspaceId, selected.path, draft);
    setContent(draft);
    setEditing(false);
  };

  if (!workspaceId) return <p className="p-3 text-[12px] text-[#5c6b7f]">Select a workspace first.</p>;

  return (
    <div className="flex h-full">
      <div className="w-52 shrink-0 overflow-y-auto border-r border-[#1c2230] py-1">
        {dir !== "." && (
          <button
            className="block w-full px-2 py-1 text-left text-[12px] text-[#8b96a8] hover:text-white"
            onClick={() => setDir(dir.split("/").slice(0, -1).join("/") || ".")}
          >
            ⬆ ..
          </button>
        )}
        {entries.map((e) => (
          <button
            key={e.path}
            className={`block w-full truncate px-2 py-1 text-left text-[12px] ${
              selected?.path === e.path ? "bg-[#1a2233] text-white" : "text-[#aab3c2] hover:bg-[#141a26]"
            }`}
            onClick={() => void open(e)}
          >
            {e.kind === "directory" ? "📁" : "📄"} {e.name}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {error && <p className="p-2 text-[12px] text-[#ff7b72]">{error}</p>}
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-[#1c2230] px-2 py-1">
              <span className="truncate text-[12px] text-[#aab3c2]">{selected.path}</span>
              <button
                className="ml-auto rounded px-1.5 text-[11px] text-[#8b96a8] hover:bg-[#1c2230] hover:text-white"
                onClick={() => app.request("window/revealPath", { path: selected.path })}
              >
                Reveal
              </button>
              {editing ? (
                <>
                  <button
                    className="rounded bg-[#1f6feb] px-2 py-0.5 text-[11px] text-white"
                    onClick={() => void save()}
                  >
                    Save
                  </button>
                  <button
                    className="rounded px-2 py-0.5 text-[11px] text-[#8b96a8] hover:bg-[#1c2230]"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="rounded px-2 py-0.5 text-[11px] text-[#8b96a8] hover:bg-[#1c2230] hover:text-white"
                  onClick={() => {
                    setDraft(content ?? "");
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <textarea
                className="min-h-0 flex-1 resize-none bg-[#0b0e14] p-2 font-mono text-[12px] text-[#dbe2ec] outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[12px] leading-5 text-[#c9d4e4]">
                {content ?? "(empty)"}
              </pre>
            )}
          </>
        ) : (
          <p className="p-3 text-[12px] text-[#5c6b7f]">Select a file to view.</p>
        )}
      </div>
    </div>
  );
}
