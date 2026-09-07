import { useTimelineStore } from "../../stores/timeline.js";
import { runtimeClient } from "../../api/client.js";

/** Top banner for pending approvals across all threads (arch.md §31). */
export default function ApprovalBanner() {
  const approvals = useTimelineStore((s) => s.approvals);
  if (approvals.length === 0) return null;
  const req = approvals[0];

  const decide = (decision: "approved_once" | "approved_session" | "rejected") => {
    void runtimeClient.respondApproval(req.approvalId, decision).catch((err: Error) => console.warn(err));
  };

  return (
    <div className="flex items-center gap-3 border-b border-[#e3b341]/30 bg-[#e3b341]/10 px-4 py-2">
      <span className="text-[12px] font-medium text-[#e3b341]">
        Approval needed ({approvals.length}) · {req.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[#a8b3c4]">{req.detail}</span>
      <button
        className="rounded bg-[#1f6feb] px-2 py-0.5 text-[11.5px] text-white hover:bg-[#388bfd]"
        onClick={() => decide("approved_once")}
      >
        Allow
      </button>
      <button
        className="rounded border border-[#ff7b72]/50 px-2 py-0.5 text-[11.5px] text-[#ff7b72] hover:bg-[#ff7b72]/10"
        onClick={() => decide("rejected")}
      >
        Reject
      </button>
    </div>
  );
}
