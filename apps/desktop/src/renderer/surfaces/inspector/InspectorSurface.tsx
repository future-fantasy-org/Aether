import { useQuery } from "@tanstack/react-query";
import { runtimeClient } from "../../api/client.js";
import { useTimelineStore } from "../../stores/timeline.js";

const CAP_KEYS: Array<[string, string]> = [
  ["plan", "Plan"],
  ["shell", "Shell"],
  ["files", "Files"],
  ["mcp", "MCP"],
  ["subAgent", "Sub-Agent"],
  ["approval", "Approval"],
  ["steer", "Steer"],
  ["fork", "Fork"],
  ["interrupt", "Interrupt"],
  ["reasoning", "Reasoning"],
];

/** Lightweight Runtime Inspector: status, capability matrix, event counts. */
export default function InspectorSurface() {
  const hostStatus = useTimelineStore((s) => s.hostStatus);
  const eventCounts = useTimelineStore((s) => s.eventCounts);

  const runtimesQ = useQuery({
    queryKey: ["runtimes"],
    queryFn: () => runtimeClient.listRuntimes(),
  });
  const capsQ = useQuery({
    queryKey: ["runtime-caps"],
    queryFn: async () => {
      const result: Record<string, Record<string, boolean>> = {};
      for (const r of runtimesQ.data?.runtimes ?? []) {
        const res = await runtimeClient.capabilities(r.runtimeId, r.backendId);
        result[`${r.runtimeId}:${r.backendId}`] = res.effective as unknown as Record<string, boolean>;
      }
      return result;
    },
    enabled: !!runtimesQ.data,
  });

  const totalEvents = Object.values(eventCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="h-full overflow-y-auto p-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[#5c6b7f]">Runtime Inspector</h3>
      <p className="mt-1 text-[12px] text-[#aab3c2]">
        Host:{" "}
        <span className={hostStatus === "ready" ? "text-[#4ade80]" : "text-[#e3b341]"}>{hostStatus}</span>
      </p>

      {(runtimesQ.data?.runtimes ?? []).map((r) => (
        <div key={`${r.runtimeId}:${r.backendId}`} className="mt-3 rounded border border-[#232b3c] bg-[#111622] p-2">
          <div className="flex items-center gap-2">
            <span className={`text-[12.5px] ${r.runtimeId === "codex" ? "text-[#4ade80]" : "text-[#4a9eff]"}`}>
              {r.name}
            </span>
            <span className="text-[10.5px] text-[#5c6b7f]">{r.backendId}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
            {CAP_KEYS.map(([key, label]) => {
              const on = capsQ.data?.[`${r.runtimeId}:${r.backendId}`]?.[key];
              return (
                <div key={key} className="flex items-center gap-1.5 text-[11.5px]">
                  <span className={on ? "text-[#4ade80]" : "text-[#3d4756]"}>{on ? "✓" : "✗"}</span>
                  <span className={on ? "text-[#aab3c2]" : "text-[#3d4756]"}>{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wider text-[#5c6b7f]">Events</h3>
      <p className="mt-1 text-[12px] text-[#aab3c2]">{totalEvents} normalized events this session</p>
      <div className="mt-1 space-y-0.5">
        {Object.entries(eventCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([type, n]) => (
            <div key={type} className="flex justify-between text-[11.5px] text-[#7d8899]">
              <span>{type}</span>
              <span>{n}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
