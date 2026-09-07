import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { newId, type AgentItem, type Thread } from "@aether/agent-domain";
import { app, runtimeClient } from "../../api/client.js";
import { useTimelineStore } from "../../stores/timeline.js";
import { useUiStore } from "../../stores/ui.js";

/**
 * Message composer with capability-driven controls (arch.md §2.5):
 * send / steer / interrupt appear based on EffectiveCapabilities and run state.
 */
export default function Composer() {
  const threadId = useUiStore((s) => s.selectedThreadId);
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const applyEvent = useTimelineStore((s) => s.applyEvent);

  const threadsQ = useQuery({
    queryKey: ["threads"],
    queryFn: () => app.request("threads/list") as Promise<{ threads: Thread[] }>,
  });
  const thread = threadsQ.data?.threads.find((t) => t.id === threadId);
  const projection = useTimelineStore((s) => (threadId ? s.projections[threadId] : undefined));
  const runActive = !!projection?.activeRunId;

  const capsQ = useQuery({
    queryKey: ["caps", thread?.runtimeBinding?.runtimeId],
    enabled: !!thread?.runtimeBinding,
    queryFn: async () => {
      const b = thread!.runtimeBinding!;
      return (await runtimeClient.capabilities(b.runtimeId, b.backendId)).effective;
    },
  });
  const caps = capsQ.data;

  const model = useMemo(() => {
    const rid = thread?.runtimeBinding?.runtimeId;
    if (rid === "deepseek") return "deepseek";
    if (rid === "codex") return "codex";
    return "agent";
  }, [thread]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [threadId]);

  const send = async () => {
    const binding = thread?.runtimeBinding;
    if (!binding?.externalThreadId || !text.trim() || sending || !thread) { return; }
    setSending(true);
    setError(undefined);
    const runId = newId("run");
    const { runtimeId, backendId } = binding;
    try {
      // Optimistic local echo of the user message.
      const optimistic: AgentItem = {
        id: newId("item"),
        threadId: thread.id,
        createdAt: new Date().toISOString(),
        type: "user_message",
        text: text.trim(),
      };
      useTimelineStore.setState((s) => ({
        projections: {
          ...s.projections,
          [thread.id]: {
            ...(s.projections[thread.id] ?? {
              threadId: thread.id,
              items: [],
              runs: {},
              activeRunId: undefined,
              pendingApprovals: [],
              lastSequence: 0,
              error: undefined,
            }),
            items: [...(s.projections[thread.id]?.items ?? []), optimistic],
          },
        },
      }));
      setText("");
      await runtimeClient.startRun({
        threadId: thread.id,
        runtimeId,
        backendId,
        externalThreadId: binding.externalThreadId,
        runId,
        text: optimistic.text,
      });
      // If the runtime didn't emit run.started yet (deepseek fires async),
      // seed the run so the composer flips to running state quickly.
      setTimeout(() => {
        const p = useTimelineStore.getState().projections[thread.id];
        if (p && !p.runs[runId]) {
          applyEvent({
            eventId: newId("evt"),
            sequence: 0,
            timestamp: new Date().toISOString(),
            runtimeId,
            backendId,
            threadId: thread.id,
            runId,
            type: "run.started",
            payload: { runId },
          });
        }
      }, 300);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
    }
  };

  const interrupt = async () => {
    const binding = thread?.runtimeBinding;
    if (!binding?.externalThreadId || !thread) return;
    try {
      await runtimeClient.interruptRun({
        threadId: thread.id,
        runtimeId: binding.runtimeId,
        backendId: binding.backendId,
        externalThreadId: binding.externalThreadId,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const steer = async () => {
    const binding = thread?.runtimeBinding;
    if (!binding?.externalThreadId || !thread || !text.trim()) return;
    try {
      await runtimeClient.steerRun({
        threadId: thread.id,
        runtimeId: binding.runtimeId,
        backendId: binding.backendId,
        externalThreadId: binding.externalThreadId,
        text: text.trim(),
      });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!thread) {
    return <div className="h-24 border-t border-[#1c2230]" />;
  }

  const canSteer = !!caps?.steer && runActive;
  const canSend = !runActive && text.trim().length > 0;

  return (
    <div className="border-t border-[#1c2230] px-4 py-3">
      {error && <p className="mb-1 text-[12px] text-[#ff7b72]">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          className="min-h-[44px] flex-1 resize-none rounded border border-[#232b3c] bg-[#111622] px-3 py-2 text-[13px] text-[#dbe2ec] outline-none placeholder:text-[#3d4756] focus:border-[#1f6feb]"
          rows={2}
          placeholder={
            runActive
              ? `Run in progress — steer the ${model} agent or wait…`
              : `Message the ${model} agent… (Enter to send)`
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSteer) void steer();
              else void send();
            }
          }}
        />
        <div className="flex flex-col gap-1.5">
          {canSteer ? (
            <button
              className="rounded bg-[#1f6feb] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#388bfd] disabled:opacity-40"
              disabled={!text.trim()}
              onClick={() => void steer()}
            >
              Steer
            </button>
          ) : (
            <button
              className="rounded bg-[#1f6feb] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#388bfd] disabled:opacity-40"
              disabled={!canSend || sending}
              onClick={() => void send()}
            >
              Send ↵
            </button>
          )}
          {runActive && caps?.interrupt && (
            <button
              className="rounded border border-[#ff7b72]/50 px-3 py-1.5 text-[12px] text-[#ff7b72] hover:bg-[#ff7b72]/10"
              onClick={() => void interrupt()}
            >
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
