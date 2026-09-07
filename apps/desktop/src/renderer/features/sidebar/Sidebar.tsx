import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { newId, type Thread, type Workspace } from "@aether/agent-domain";
import { app, runtimeClient } from "../../api/client.js";
import { useUiStore } from "../../stores/ui.js";
import { DEFAULT_SETTINGS, type AppSettings } from "@aether/desktop-contracts";
import { selectThreadContext } from "./threadService.js";

export default function Sidebar() {
  const queryClient = useQueryClient();
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectWorkspace = useUiStore((s) => s.selectWorkspace);
  const selectThread = useUiStore((s) => s.selectThread);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const openSurface = useUiStore((s) => s.openSurface);
  const [showNewThread, setShowNewThread] = useState(false);

  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => app.request("workspaces/list") as Promise<{ workspaces: Workspace[] }>,
  });

  const threadsQ = useQuery({
    queryKey: ["threads", selectedWorkspaceId],
    enabled: !!selectedWorkspaceId,
    queryFn: () =>
      app.request("threads/list", { workspaceId: selectedWorkspaceId }) as Promise<{
        threads: Thread[];
      }>,
  });

  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: () => app.request("settings/get") as Promise<AppSettings>,
  });

  const addWorkspace = useMutation({
    mutationFn: async () => {
      const picked = (await app.request("window/pickDirectory")) as { path: string | null };
      if (!picked.path) return;
      await app.request("workspaces/create", { rootPath: picked.path });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  });

  const runtimesQ = useQuery({
    queryKey: ["runtimes"],
    queryFn: () => runtimeClient.listRuntimes(),
  });

  const createThread = useMutation({
    mutationFn: async (params: { runtimeId: string; backendId: string; title: string; model?: string }) => {
      const workspace = workspacesQ.data?.workspaces.find((w) => w.id === selectedWorkspaceId);
      if (!workspace || workspace.binding.kind !== "local") throw new Error("select a local workspace first");
      const threadId = newId("th");
      const settings = settingsQ.data ?? DEFAULT_SETTINGS;
      const res = await runtimeClient.createThread({
        threadId,
        runtimeId: params.runtimeId,
        backendId: params.backendId,
        cwd: workspace.binding.rootPath,
        title: params.title,
        model: params.model,
        approvalMode: settings.approvalMode,
      });
      const thread: Thread = {
        id: threadId,
        workspaceId: workspace.id,
        title: params.title || "New chat",
        runtimeBinding: {
          runtimeId: params.runtimeId,
          backendId: params.backendId,
          externalThreadId: res.thread.externalThreadId,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
      };
      await app.request("threads/upsert", { thread });
      return thread;
    },
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      void selectThreadContext(thread);
      selectThread(thread.id);
      setShowNewThread(false);
    },
  });

  const threads = useMemo(
    () => (threadsQ.data?.threads ?? []).filter((t) => !t.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [threadsQ.data],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5c6b7f]">
          Workspaces
        </span>
        <button
          className="rounded px-1.5 text-[#8b96a8] hover:bg-[#1c2230] hover:text-white"
          title="Add workspace"
          onClick={() => addWorkspace.mutate()}
        >
          +
        </button>
      </div>
      <div className="px-1">
        {(workspacesQ.data?.workspaces ?? []).map((w) => (
          <button
            key={w.id}
            onClick={() => selectWorkspace(w.id)}
            className={`block w-full truncate rounded px-2 py-1.5 text-left text-[13px] ${
              selectedWorkspaceId === w.id ? "bg-[#1a2233] text-white" : "text-[#aab3c2] hover:bg-[#141a26]"
            }`}
            title={w.binding.kind === "local" ? w.binding.rootPath : w.name}
          >
            <span className="mr-1.5 text-[#4a9eff]">▣</span>
            {w.name}
          </button>
        ))}
        {workspacesQ.data?.workspaces.length === 0 && (
          <p className="px-2 py-1 text-[12px] text-[#5c6b7f]">No workspaces yet. Click + to add one.</p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between px-3 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5c6b7f]">Threads</span>
        <button
          className="rounded px-1.5 text-[#8b96a8] hover:bg-[#1c2230] hover:text-white disabled:opacity-30"
          title="New thread"
          disabled={!selectedWorkspaceId}
          onClick={() => setShowNewThread((v) => !v)}
        >
          +
        </button>
      </div>

      {showNewThread && (
        <div className="mx-2 mb-2 rounded border border-[#232b3c] bg-[#111622] p-2">
          {runtimesQ.data?.runtimes.map((r) => (
            <button
              key={`${r.runtimeId}:${r.backendId}`}
              className="mb-1 block w-full rounded px-2 py-1.5 text-left text-[12px] text-[#aab3c2] hover:bg-[#1a2233] hover:text-white"
              onClick={() => createThread.mutate({ runtimeId: r.runtimeId, backendId: r.backendId, title: "" })}
            >
              <span className={`mr-1.5 ${r.runtimeId === "codex" ? "text-[#4ade80]" : "text-[#4a9eff]"}`}>●</span>
              New {r.name} thread
              <span className="ml-1 text-[10px] text-[#5c6b7f]">{r.backendId}</span>
            </button>
          ))}
          {createThread.isError && (
            <p className="text-[11px] text-[#ff7b72]">{(createThread.error as Error).message}</p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {threads.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              selectThread(t.id);
              void selectThreadContext(t);
            }}
            className={`block w-full truncate rounded px-2 py-1.5 text-left text-[13px] ${
              selectedThreadId === t.id ? "bg-[#1a2233] text-white" : "text-[#aab3c2] hover:bg-[#141a26]"
            }`}
          >
            <span className={`mr-1.5 ${t.runtimeBinding?.runtimeId === "codex" ? "text-[#4ade80]" : "text-[#4a9eff]"}`}>
              {t.runtimeBinding?.runtimeId === "codex" ? "⬢" : "◆"}
            </span>
            {t.title || "Untitled"}
          </button>
        ))}
        {selectedWorkspaceId && threads.length === 0 && !threadsQ.isLoading && (
          <p className="px-2 py-1 text-[12px] text-[#5c6b7f]">No threads yet.</p>
        )}
      </div>

      <div className="border-t border-[#1c2230] p-2">
        <div className="mb-1 flex gap-1">
          {(
            [
              ["files", "🗂 Files", "Files"],
              ["terminal", "▶ Terminal", "Terminal"],
              ["artifact", "📄 Artifacts", "Artifacts"],
              ["inspector", "🛠 Inspector", "Runtime Inspector"],
            ] as const
          ).map(([kind, short, title]) => (
            <button
              key={kind}
              className="flex-1 rounded border border-[#232b3c] px-1 py-1 text-[11px] text-[#8b96a8] hover:bg-[#1c2230] hover:text-white disabled:opacity-30"
              disabled={!selectedWorkspaceId && kind !== "inspector"}
              title={title}
              onClick={() => {
                if (kind === "artifact") {
                  if (selectedThreadId) openSurface({ id: `artifact:${selectedThreadId}`, kind, title, props: { threadId: selectedThreadId } });
                  return;
                }
                openSurface({
                  id: `${kind}:${selectedWorkspaceId ?? ""}`,
                  kind,
                  title: short.replace(/^\S+\s/, ""),
                  props: { workspaceId: selectedWorkspaceId ?? "" },
                });
              }}
            >
              {short.split(" ")[0]}
            </button>
          ))}
        </div>
        <button
          className="w-full rounded px-2 py-1.5 text-left text-[12px] text-[#8b96a8] hover:bg-[#1c2230] hover:text-white"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙ Settings
        </button>
      </div>
    </div>
  );
}
