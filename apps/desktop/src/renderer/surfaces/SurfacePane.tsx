import { useUiStore, type Surface } from "../stores/ui.js";
import FilesSurface from "./files/FilesSurface.js";
import DiffSurface from "./diff/DiffSurface.js";
import TerminalSurface from "./terminal/TerminalSurface.js";
import ArtifactSurface from "./artifacts/ArtifactSurface.js";
import InspectorSurface from "./inspector/InspectorSurface.js";

function SurfaceBody({ surface }: { surface: Surface }) {
  switch (surface.kind) {
    case "files":
      return <FilesSurface workspaceId={String(surface.props.workspaceId ?? "")} />;
    case "diff":
      return (
        <DiffSurface
          path={String(surface.props.path ?? "")}
          patch={surface.props.patch as string | undefined}
          workspaceId={String(surface.props.workspaceId ?? "")}
        />
      );
    case "terminal":
      return <TerminalSurface workspaceId={String(surface.props.workspaceId ?? "")} />;
    case "artifact":
      return <ArtifactSurface threadId={String(surface.props.threadId ?? "")} />;
    case "inspector":
      return <InspectorSurface />;
    default:
      return null;
  }
}

export default function SurfacePane() {
  const surfaces = useUiStore((s) => s.surfaces);
  const activeSurfaceId = useUiStore((s) => s.activeSurfaceId);
  const setActiveSurface = useUiStore((s) => s.setActiveSurface);
  const closeSurface = useUiStore((s) => s.closeSurface);
  const togglePin = useUiStore((s) => s.togglePin);
  const setSurfaceOpen = useUiStore((s) => s.setSurfaceOpen);

  const active = surfaces.find((s) => s.id === activeSurfaceId) ?? surfaces.at(-1);
  if (!active) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[#3d4756]">
        No surfaces open
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[34px] items-center overflow-x-auto border-b border-[#1c2230]">
        {surfaces.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveSurface(s.id)}
            className={`group flex shrink-0 items-center gap-1 border-r border-[#1c2230] px-3 py-1.5 text-[12px] ${
              s.id === active.id ? "bg-[#141a26] text-white" : "text-[#8b96a8] hover:text-[#dbe2ec]"
            }`}
          >
            <span>
              {s.kind === "files" ? "🗂" : s.kind === "diff" ? "±" : s.kind === "terminal" ? "▶" : s.kind === "artifact" ? "📄" : "🛠"}{" "}
              {s.title}
            </span>
            <span
              className="ml-1 hidden rounded px-0.5 text-[10px] hover:bg-[#2a3140] group-hover:inline"
              title={s.pinned ? "Unpin" : "Pin"}
              onClick={(e) => {
                e.stopPropagation();
                togglePin(s.id);
              }}
            >
              {s.pinned ? "📌" : "pin"}
            </span>
            <span
              className="hidden rounded px-1 text-[11px] text-[#8b96a8] hover:text-[#ff7b72] group-hover:inline"
              onClick={(e) => {
                e.stopPropagation();
                closeSurface(s.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button
          className="ml-auto px-2 text-[11px] text-[#5c6b7f] hover:text-white"
          title="Collapse surface pane"
          onClick={() => setSurfaceOpen(false)}
        >
          ▸
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <SurfaceBody surface={active} />
      </div>
    </div>
  );
}
