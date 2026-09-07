import { useEffect, useRef, useState } from "react";
import { runtimeClient } from "../../api/client.js";

/**
 * Terminal surface backed by a PTY inside the Agent Execution Host
 * (arch.md §29) — never a renderer-side child_process.
 */
export default function TerminalSurface({ workspaceId }: { workspaceId: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ write(d: string): void; dispose(): void; resize?(c: number, r: number): void } | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;

    (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        await import("@xterm/xterm/css/xterm.css");
        if (disposed || !holder.current) return;

        const term = new Terminal({
          fontFamily: "Menlo, monospace",
          fontSize: 12,
          cursorBlink: true,
          theme: { background: "#0b0e14", foreground: "#c9d4e4" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(holder.current);
        fit.fit();
        termRef.current = term as never;

        const { terminalId } = await runtimeClient.terminalCreate(workspaceId);
        if (disposed) {
          void runtimeClient.terminalDispose(terminalId);
          term.dispose();
          return;
        }
        terminalIdRef.current = terminalId;

        off = runtimeClient.onTerminal(terminalId, (p) => {
          if (p.data !== undefined) term.write(p.data);
          if (p.exitCode !== undefined) term.write(`\r\n\x1b[90m[process exited: ${p.exitCode}]\x1b[0m\r\n`);
        });

        term.onData((data) => {
          void runtimeClient.terminalWrite(terminalId, data);
        });

        const onResize = () => {
          fit.fit();
          if (term.cols && term.rows) {
            void runtimeClient.terminalResize(terminalId, term.cols, term.rows);
          }
        };
        window.addEventListener("resize", onResize);
      } catch (err) {
        setError((err as Error).message);
      }
    })();

    return () => {
      disposed = true;
      off?.();
      if (terminalIdRef.current) void runtimeClient.terminalDispose(terminalIdRef.current);
      termRef.current?.dispose();
    };
  }, [workspaceId]);

  if (!workspaceId) return <p className="p-3 text-[12px] text-[#5c6b7f]">Select a workspace first.</p>;

  return (
    <div className="flex h-full flex-col">
      {error && <p className="p-2 text-[12px] text-[#ff7b72]">{error}</p>}
      <div ref={holder} className="min-h-0 flex-1 p-1" />
    </div>
  );
}
