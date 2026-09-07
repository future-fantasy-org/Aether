import { useEffect } from "react";
import { runtimeClient } from "./api/client.js";
import { useTimelineStore } from "./stores/timeline.js";
import { useUiStore } from "./stores/ui.js";
import Sidebar from "./features/sidebar/Sidebar.js";
import Timeline from "./features/timeline/Timeline.js";
import Composer from "./features/composer/Composer.js";
import ApprovalBanner from "./features/approvals/ApprovalBanner.js";
import SurfacePane from "./surfaces/SurfacePane.js";
import SettingsPage from "./features/settings/SettingsPage.js";

export default function App() {
  const applyEvent = useTimelineStore((s) => s.applyEvent);
  const addApproval = useTimelineStore((s) => s.addApproval);
  const removeApproval = useTimelineStore((s) => s.removeApproval);
  const setHostStatus = useTimelineStore((s) => s.setHostStatus);
  const surfaceOpen = useUiStore((s) => s.surfaceOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);

  useEffect(() => {
    runtimeClient.connect();
    const offs = [
      runtimeClient.onRuntimeEvent(applyEvent),
      runtimeClient.onApproval(addApproval),
      runtimeClient.onApprovalResolved((p) => removeApproval(p.approvalId)),
      runtimeClient.onHostStatus((s) => setHostStatus(s.status)),
    ];
    return () => {
      offs.forEach((off) => off());
      runtimeClient.dispose();
    };
  }, [applyEvent, addApproval, removeApproval, setHostStatus]);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Drag region for the hidden-inset title bar */}
      <div className="h-9 w-full shrink-0" style={{ WebkitAppRegion: "drag" } as never} />
      <div className="flex min-h-0 flex-1 gap-0">
        <aside className="w-64 shrink-0 border-r border-[#1c2230] bg-[#0d1119]">
          <Sidebar />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-[#0b0e14]">
          <ApprovalBanner />
          <Timeline />
          <Composer />
        </main>
        {surfaceOpen && (
          <section className="w-[460px] shrink-0 border-l border-[#1c2230] bg-[#0d1119]">
            <SurfacePane />
          </section>
        )}
      </div>
      {settingsOpen && <SettingsPage />}
    </div>
  );
}
