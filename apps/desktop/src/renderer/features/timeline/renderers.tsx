import { useState } from "react";
import type { AgentItem } from "@aether/agent-domain";
import { Markdown, registerRenderer } from "./registry.js";
import { runtimeClient } from "../../api/client.js";

const label = "text-[10px] font-semibold uppercase tracking-wider";

function Row({ tag, tagColor, children }: { tag: string; tagColor: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 border-l-2 border-transparent py-1.5 pl-3 hover:border-[#2a3140]">
      <div className="w-16 shrink-0 pt-0.5">
        <span className={`${label} ${tagColor}`}>{tag}</span>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

type ExtractItem<T extends AgentItem["type"]> = Extract<AgentItem, { type: T }>;

registerRenderer("user_message", ({ item }) => {
  const i = item as ExtractItem<"user_message">;
  return (
    <Row tag="User" tagColor="text-[#e6e8ee]">
      <div className="rounded border border-[#232b3c] bg-[#111622] px-2.5 py-1.5 text-[13px] text-[#dbe2ec]">
        {i.text}
      </div>
    </Row>
  );
});

registerRenderer("agent_message", ({ item }) => {
  const i = item as ExtractItem<"agent_message">;
  return (
    <Row tag="Agent" tagColor="text-[#4ade80]">
      <div className="text-[13px] leading-6 text-[#dbe2ec]">
        <Markdown text={i.text} />
        {i.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-[#4ade80] align-middle" />}
      </div>
    </Row>
  );
});

registerRenderer("reasoning_summary", ({ item }) => {
  const i = item as ExtractItem<"reasoning_summary">;
  return (
    <Row tag="Think" tagColor="text-[#8b96a8]">
      <details className="rounded border border-[#1c2230] bg-[#0d1119] px-2 py-1">
        <summary className="cursor-pointer text-[11px] text-[#8b96a8]">Reasoning</summary>
        <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-[#7d8899]">{i.text}</div>
      </details>
    </Row>
  );
});

registerRenderer("plan", ({ item }) => {
  const i = item as ExtractItem<"plan">;
  return (
    <Row tag="Plan" tagColor="text-[#d2a8ff]">
      <div className="rounded border border-[#232b3c] bg-[#111622] px-2.5 py-2">
        {i.steps.length === 0 && <span className="text-[12px] text-[#8b96a8] italic">Planning…</span>}
        {i.steps.map((s, idx) => (
          <div key={idx} className="flex items-start gap-2 py-0.5 text-[12.5px]">
            <span
              className={
                s.status === "completed"
                  ? "text-[#4ade80]"
                  : s.status === "in_progress"
                    ? "animate-pulse text-[#e3b341]"
                    : "text-[#5c6b7f]"
              }
            >
              {s.status === "completed" ? "✓" : s.status === "in_progress" ? "◐" : "○"}
            </span>
            <span className={s.status === "completed" ? "text-[#7d8899] line-through" : "text-[#dbe2ec]"}>
              {s.text}
            </span>
          </div>
        ))}
      </div>
    </Row>
  );
});

registerRenderer("tool_call", ({ item }) => {
  const i = item as ExtractItem<"tool_call">;
  const [open, setOpen] = useState(false);
  return (
    <Row tag="Tool" tagColor="text-[#e3b341]">
      <button className="text-left text-[12.5px]" onClick={() => setOpen((v) => !v)}>
        <span className={i.status === "failed" ? "text-[#ff7b72]" : i.status === "completed" ? "text-[#4ade80]" : "text-[#e3b341]"}>
          {i.status === "running" ? "◐" : i.status === "failed" ? "✗" : "✓"}
        </span>{" "}
        <code className="text-[#79c0ff]">{i.tool}</code>{" "}
        <span className="text-[#5c6b7f]">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {i.input && (
            <pre className="max-h-32 overflow-auto rounded bg-[#0d1119] p-1.5 text-[11px] text-[#c9d4e4]">{i.input}</pre>
          )}
          {i.output && (
            <pre className="max-h-48 overflow-auto rounded bg-[#0d1119] p-1.5 text-[11px] text-[#7d8899]">{i.output}</pre>
          )}
        </div>
      )}
    </Row>
  );
});

registerRenderer("command", ({ item }) => {
  const i = item as ExtractItem<"command">;
  const [open, setOpen] = useState(i.status === "running");
  return (
    <Row tag="Shell" tagColor="text-[#79c0ff]">
      <button className="w-full text-left" onClick={() => setOpen((v) => !v)}>
        <code className="text-[12.5px] text-[#dbe2ec]">$ {i.command}</code>{" "}
        <span className="text-[11px]">
          {i.status === "running" ? (
            <span className="animate-pulse text-[#e3b341]">running…</span>
          ) : i.status === "failed" ? (
            <span className="text-[#ff7b72]">✗ exit {i.exitCode}</span>
          ) : (
            <span className="text-[#4ade80]">✓</span>
          )}
          <span className="ml-1 text-[#5c6b7f]">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && i.output && (
        <pre className="mt-1 max-h-60 overflow-auto rounded border border-[#1c2230] bg-black/40 p-1.5 text-[11px] leading-5 text-[#a8b3c4]">
          {i.output}
        </pre>
      )}
    </Row>
  );
});

registerRenderer("file_change", ({ item, onOpenDiff }) => {
  const i = item as ExtractItem<"file_change">;
  const icon = i.changeType === "added" ? "A" : i.changeType === "deleted" ? "D" : "M";
  const color =
    i.changeType === "added" ? "text-[#4ade80]" : i.changeType === "deleted" ? "text-[#ff7b72]" : "text-[#e3b341]";
  return (
    <Row tag={icon} tagColor={color}>
      <button className="text-left text-[12.5px] hover:underline" onClick={() => onOpenDiff?.(i.path, i.patch)}>
        <span className={color}>{icon}</span> <span className="text-[#dbe2ec]">{i.path}</span>{" "}
        <span className="text-[11px] text-[#4ade80]">+{i.additions}</span>{" "}
        <span className="text-[11px] text-[#ff7b72]">-{i.deletions}</span>
      </button>
    </Row>
  );
});

registerRenderer("approval", ({ item }) => {
  const i = item as ExtractItem<"approval">;
  const riskColor =
    i.risk === "high"
      ? "text-[#ff7b72] border-[#ff7b72]"
      : i.risk === "medium"
        ? "text-[#e3b341] border-[#e3b341]"
        : "text-[#4ade80] border-[#4ade80]";
  const decide = (decision: "approved_once" | "approved_session" | "rejected") => {
    void runtimeClient.respondApproval(i.approvalId, decision).catch((err: Error) => console.warn(err));
  };
  return (
    <Row tag="Ask" tagColor="text-[#e3b341]">
      <div className="rounded border border-[#2a3140] bg-[#111622] p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-[#dbe2ec]">{i.title}</span>
          <span className={`rounded border px-1.5 text-[10px] font-semibold uppercase ${riskColor}`}>{i.risk}</span>
        </div>
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-1.5 text-[11.5px] text-[#a8b3c4]">
          {i.detail}
        </pre>
        {i.decision === "pending" ? (
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-[#1f6feb] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#388bfd]"
              onClick={() => decide("approved_once")}
            >
              Allow once
            </button>
            <button
              className="rounded border border-[#2a3140] px-2.5 py-1 text-[12px] text-[#aab3c2] hover:bg-[#1c2230]"
              onClick={() => decide("approved_session")}
            >
              Always allow
            </button>
            <button
              className="rounded border border-[#ff7b72]/40 px-2.5 py-1 text-[12px] text-[#ff7b72] hover:bg-[#ff7b72]/10"
              onClick={() => decide("rejected")}
            >
              Reject
            </button>
          </div>
        ) : (
          <div className="mt-2 text-[11.5px] text-[#7d8899]">
            Decision:{" "}
            <span className={i.decision === "rejected" || i.decision === "cancelled" ? "text-[#ff7b72]" : "text-[#4ade80]"}>
              {i.decision}
            </span>
          </div>
        )}
      </div>
    </Row>
  );
});

registerRenderer("error", ({ item }) => {
  const i = item as ExtractItem<"error">;
  return (
    <Row tag="Error" tagColor="text-[#ff7b72]">
      <div className="rounded border border-[#ff7b72]/30 bg-[#ff7b72]/5 px-2.5 py-1.5 text-[12.5px] text-[#ff9d96]">
        {i.message}
        {i.fatal && <span className="ml-1 text-[10px] uppercase text-[#ff7b72]">fatal</span>}
      </div>
    </Row>
  );
});

registerRenderer("notice", ({ item }) => {
  const i = item as ExtractItem<"notice">;
  return (
    <Row tag="Note" tagColor="text-[#8b96a8]">
      <div className="text-[12px] text-[#8b96a8]">{i.message}</div>
    </Row>
  );
});

registerRenderer("artifact", ({ item }) => {
  const i = item as ExtractItem<"artifact">;
  return (
    <Row tag="Art" tagColor="text-[#d2a8ff]">
      <span className="text-[12.5px] text-[#dbe2ec]">
        📄 {i.title} <span className="text-[11px] text-[#5c6b7f]">({i.artifactType})</span>
      </span>
    </Row>
  );
});

registerRenderer("search", ({ item }) => {
  const i = item as ExtractItem<"search">;
  return (
    <Row tag="Find" tagColor="text-[#79c0ff]">
      <span className="text-[12.5px] text-[#aab3c2]">🔍 {i.query}</span>
    </Row>
  );
});

// Registrations are side effects; import this module so the renderers
// attach themselves to the registry.
export {};
