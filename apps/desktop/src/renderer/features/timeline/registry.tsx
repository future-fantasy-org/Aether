import type { AgentItem, AgentItemType } from "@aether/agent-domain";
import type { ReactNode } from "react";

export interface ItemRendererProps<T = AgentItem> {
  item: T;
  onOpenDiff?: (path: string, patch?: string) => void;
}

type RendererComponent = (props: ItemRendererProps<never>) => ReactNode;

const registry = new Map<AgentItemType, RendererComponent>();

export function registerRenderer(type: AgentItemType, component: RendererComponent): void {
  registry.set(type, component);
}

export function getRenderer(type: AgentItemType): RendererComponent {
  return (
    registry.get(type) ??
    (({ item }) => <div className="px-3 py-1 text-[12px] text-[#5c6b7f]">{(item as { type: string }).type}</div>)
  );
}

// --- Tiny markdown renderer (paragraph/code/bold/inline-code/lists) ---

export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.startsWith("```")) {
          const lines = block.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "");
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded border border-[#232b3c] bg-[#0d1119] p-2 text-[12px] leading-5 text-[#c9d4e4]"
            >
              <code>{lines}</code>
            </pre>
          );
        }
        const isList = block.split("\n").every((l) => /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.split("\n").map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+|^\s*\d+\.\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{inline(block)}</p>;
      })}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      parts.push(
        <code key={key++} className="rounded bg-[#161c29] px-1 py-0.5 text-[12px] text-[#79c0ff]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(
        <strong key={key++} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
