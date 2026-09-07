import { useEffect, useState } from "react";
import { runtimeClient } from "../../api/client.js";

/**
 * Unified-diff view: renders the patch shipped with FileChangeItem; when no
 * patch is available, falls back to showing the current file content with a
 * note that the agent modified it.
 */
export default function DiffSurface({
  path,
  patch,
  workspaceId,
}: {
  path: string;
  patch?: string;
  workspaceId: string;
}) {
  const [current, setCurrent] = useState<string | undefined>();

  useEffect(() => {
    if (!patch && workspaceId) {
      runtimeClient
        .fsRead(workspaceId, path)
        .then((r) => setCurrent(r.content.content))
        .catch(() => setCurrent(undefined));
    }
  }, [path, patch, workspaceId]);

  const lines = (patch ?? "").split("\n");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#1c2230] px-2 py-1">
        <span className="truncate text-[12px] text-[#aab3c2]">± {path}</span>
      </div>
      {patch ? (
        <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
          {lines.map((line, i) => {
            if (line.startsWith("@@")) {
              return (
                <div key={i} className="bg-[#1c2a3a] px-2 text-[#79c0ff]">
                  {line}
                </div>
              );
            }
            if (line.startsWith("+")) {
              return (
                <div key={i} className="bg-[#123122] px-2 text-[#7ee787]">
                  {line}
                </div>
              );
            }
            if (line.startsWith("-")) {
              return (
                <div key={i} className="bg-[#3a1216] px-2 text-[#ffa198]">
                  {line}
                </div>
              );
            }
            return (
              <div key={i} className="px-2 text-[#7d8899]">
                {line}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <p className="mb-2 text-[12px] text-[#5c6b7f]">
            No patch recorded — showing current content (modified by agent).
          </p>
          <pre className="font-mono text-[12px] leading-5 text-[#c9d4e4]">{current ?? "(unavailable)"}</pre>
        </div>
      )}
    </div>
  );
}
