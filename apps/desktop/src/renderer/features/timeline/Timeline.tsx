import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Thread } from "@aether/agent-domain";
import { app } from "../../api/client.js";
import { useTimelineStore } from "../../stores/timeline.js";
import { useUiStore } from "../../stores/ui.js";
import { getRenderer } from "./registry.js";
import "./renderers.js";

export default function Timeline() {
  const threadId = useUiStore((s) => s.selectedThreadId);
  const openSurface = useUiStore((s) => s.openSurface);
  const projection = useTimelineStore((s) => (threadId ? s.projections[threadId] : undefined));
  const hostStatus = useTimelineStore((s) => s.hostStatus);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const threadsQ = useQuery({
    queryKey: ["threads"],
    queryFn: () => app.request("threads/list") as Promise<{ threads: Thread[] }>,
  });
  const thread = threadsQ.data?.threads.find((t) => t.id === threadId);

  const items = projection?.items ?? [];
  const activeRun = projection?.activeRunId
    ? projection.runs[projection.activeRunId]
    : undefined;

  useLayoutEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [items]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [threadId]);

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-[15px] text-[#5c6b7f]">Aether · One workspace, every agent</p>
          <p className="mt-1 text-[12px] text-[#3d4756]">Select a workspace and start a thread</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[#1c2230] px-4 py-2">
        <span className={`text-[11px] ${thread.runtimeBinding?.runtimeId === "codex" ? "text-[#4ade80]" : "text-[#4a9eff]"}`}>
          {thread.runtimeBinding?.runtimeId === "codex" ? "⬢ codex" : "◆ deepseek"}
        </span>
        <span className="truncate text-[13px] font-medium text-[#dbe2ec]">{thread.title || "Untitled"}</span>
        {activeRun && (
          <span className="ml-auto animate-pulse text-[11px] text-[#e3b341]">
            {activeRun.status === "WAITING_APPROVAL" ? "waiting approval…" : "running…"}
          </span>
        )}
        {hostStatus !== "ready" && hostStatus !== "reconnected" && (
          <span className="ml-auto text-[11px] text-[#e3b341]">host: {hostStatus}</span>
        )}
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {items.length === 0 && (
          <p className="py-8 text-center text-[12px] text-[#3d4756]">Send a message to start a run</p>
        )}
        {items.map((item) => {
          const Renderer = getRenderer(item.type);
          return (
            <Renderer
              key={item.id}
              item={item as never}
              onOpenDiff={(path, patch) =>
                openSurface({
                  id: `diff:${path}`,
                  kind: "diff",
                  title: path,
                  props: { path, patch, workspaceId: thread.workspaceId },
                })
              }
            />
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
