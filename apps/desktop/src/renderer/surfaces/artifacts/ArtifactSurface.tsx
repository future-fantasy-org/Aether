import { useEffect, useState } from "react";
import { runtimeClient, app } from "../../api/client.js";
import type { ArtifactMeta } from "@aether/agent-runtime-client";

/** Artifact list + preview + export (arch.md §30). */
export default function ArtifactSurface({ threadId }: { threadId: string }) {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [selected, setSelected] = useState<ArtifactMeta | undefined>();
  const [content, setContent] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = async () => {
    try {
      const res = await runtimeClient.artifactList(threadId);
      setArtifacts(res.artifacts);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (threadId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const open = async (a: ArtifactMeta) => {
    setSelected(a);
    try {
      const res = await runtimeClient.artifactRead(a.id);
      setContent(res.content);
    } catch {
      setContent(undefined);
    }
  };

  const exportArtifact = async () => {
    if (!selected) return;
    const picked = (await app.request("window/pickDirectory")) as { path: string | null };
    if (!picked.path) return;
    const dest = `${picked.path.replace(/\/$/, "")}/${selected.title}`;
    await runtimeClient.artifactExport(selected.id, dest);
    await app.request("window/notify", { title: "Artifact exported", body: dest });
  };

  const openOriginal = async () => {
    if (selected?.location.kind === "local") {
      await app.request("window/openPath", { path: selected.location.path });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#1c2230] px-2 py-1">
        <span className="text-[12px] text-[#8b96a8]">{artifacts.length} artifacts</span>
        <button className="ml-auto rounded px-1.5 text-[11px] text-[#8b96a8] hover:bg-[#1c2230] hover:text-white" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-2 text-[12px] text-[#ff7b72]">{error}</p>}
        {artifacts.map((a) => (
          <button
            key={a.id}
            onClick={() => void open(a)}
            className={`block w-full px-2 py-1.5 text-left text-[12.5px] ${
              selected?.id === a.id ? "bg-[#1a2233] text-white" : "text-[#aab3c2] hover:bg-[#141a26]"
            }`}
          >
            📄 {a.title} <span className="text-[10px] text-[#5c6b7f]">{a.type}</span>
          </button>
        ))}
        {artifacts.length === 0 && <p className="p-3 text-[12px] text-[#5c6b7f]">No artifacts yet.</p>}
      </div>
      {selected && (
        <div className="max-h-[60%] shrink-0 border-t border-[#1c2230]">
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="truncate text-[12px] text-[#aab3c2]">{selected.title}</span>
            <button className="ml-auto rounded px-1.5 text-[11px] text-[#8b96a8] hover:bg-[#1c2230] hover:text-white" onClick={() => void openOriginal()}>
              Open
            </button>
            <button className="rounded bg-[#1f6feb] px-2 py-0.5 text-[11px] text-white hover:bg-[#388bfd]" onClick={() => void exportArtifact()}>
              Export
            </button>
          </div>
          <pre className="max-h-56 overflow-auto border-t border-[#1c2230] p-2 font-mono text-[11.5px] leading-5 text-[#c9d4e4]">
            {content ?? "(binary or unavailable)"}
          </pre>
        </div>
      )}
    </div>
  );
}
