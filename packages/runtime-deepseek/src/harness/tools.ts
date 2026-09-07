import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveInside } from "@aether/workspace-provider";
import type { ToolSchema } from "./deepseekClient.js";

export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

const MAX_READ = 64 * 1024;
const MAX_GLOB = 200;
const MAX_GREP = 100;

const schema = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSchema => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});

export function toolSchemas(): ToolSchema[] {
  return [
    schema(
      "read_file",
      "Read a text file's content (relative to the workspace). Returns up to 64KB.",
      { path: { type: "string", description: "Relative file path" } },
      ["path"],
    ),
    schema(
      "write_file",
      "Create or overwrite a file with the given content (relative to the workspace).",
      {
        path: { type: "string", description: "Relative file path" },
        content: { type: "string", description: "Full file content" },
      },
      ["path", "content"],
    ),
    schema(
      "edit_file",
      "Replace an exact string in a file. old_string must match exactly once.",
      {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      ["path", "old_string", "new_string"],
    ),
    schema(
      "glob",
      "List files matching a glob pattern like 'src/**/*.ts'.",
      { pattern: { type: "string" } },
      ["pattern"],
    ),
    schema(
      "grep",
      "Search file contents for a substring or regex. Returns matching lines.",
      {
        query: { type: "string" },
        glob: { type: "string", description: "Optional glob filter, e.g. '*.ts'" },
      },
      ["query"],
    ),
    schema(
      "run_shell",
      "Run a shell command in the workspace directory (120s timeout).",
      { command: { type: "string" } },
      ["command"],
    ),
  ];
}

async function walk(dir: string, out: string[], root: string): Promise<void> {
  if (out.length >= MAX_GLOB * 5) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, root);
    else out.push(path.relative(root, full));
  }
}

function globToRegExp(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  onCommandOutput?: (delta: string) => void,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file": {
        const file = resolveInside(ctx.cwd, String(args.path));
        const buf = await fs.readFile(file);
        const truncated = buf.byteLength > MAX_READ;
        return { ok: true, output: buf.subarray(0, MAX_READ).toString("utf8") + (truncated ? "\n... (truncated)" : "") };
      }
      case "write_file": {
        const file = resolveInside(ctx.cwd, String(args.path));
        await fs.mkdir(path.dirname(file), { recursive: true });
        const existed = await fs
          .stat(file)
          .then(() => true)
          .catch(() => false);
        await fs.writeFile(file, String(args.content ?? ""), "utf8");
        return { ok: true, output: existed ? `updated ${args.path}` : `created ${args.path}` };
      }
      case "edit_file": {
        const file = resolveInside(ctx.cwd, String(args.path));
        const content = await fs.readFile(file, "utf8");
        const oldS = String(args.old_string);
        const newS = String(args.new_string);
        const first = content.indexOf(oldS);
        if (first < 0) return { ok: false, output: `old_string not found in ${args.path}` };
        if (content.indexOf(oldS, first + 1) >= 0)
          return { ok: false, output: `old_string matches more than once in ${args.path}` };
        await fs.writeFile(file, content.slice(0, first) + newS + content.slice(first + oldS.length), "utf8");
        return { ok: true, output: `edited ${args.path}` };
      }
      case "glob": {
        const re = globToRegExp(String(args.pattern));
        const files: string[] = [];
        await walk(ctx.cwd, files, ctx.cwd);
        const matches = files.filter((f) => re.test(f)).slice(0, MAX_GLOB);
        return { ok: true, output: matches.join("\n") || "(no matches)" };
      }
      case "grep": {
        const query = String(args.query);
        let re: RegExp;
        try {
          re = new RegExp(query);
        } catch {
          re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        }
        const filter = args.glob ? globToRegExp(String(args.glob)) : null;
        const files: string[] = [];
        await walk(ctx.cwd, files, ctx.cwd);
        const lines: string[] = [];
        for (const f of files) {
          if (filter && !filter.test(f)) continue;
          if (lines.length >= MAX_GREP) break;
          let content: string;
          try {
            content = await fs.readFile(path.join(ctx.cwd, f), "utf8");
          } catch {
            continue;
          }
          for (const [i, line] of content.split("\n").entries()) {
            if (re.test(line)) {
              lines.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
              if (lines.length >= MAX_GREP) break;
            }
          }
        }
        return { ok: true, output: lines.join("\n") || "(no matches)" };
      }
      case "run_shell": {
        const command = String(args.command);
        const shell = process.env.SHELL ?? "/bin/zsh";
        const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>(
          (resolve) => {
            execFile(
              shell,
              ["-c", command],
              { cwd: ctx.cwd, timeout: 120_000, maxBuffer: 1024 * 1024 },
              (err, stdout, stderr) => {
                const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
                const code = e?.code !== undefined && e.code !== null ? Number(e.code) : 0;
                resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: code || (e ? 1 : 0) });
              },
            );
          },
        );
        if (onCommandOutput) onCommandOutput(stdout + (stderr ? `\n${stderr}` : ""));
        const output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
        return { ok: code === 0, output: code === 0 ? output.slice(0, 16 * 1024) : `exit ${code}\n${output.slice(0, 16 * 1024)}` };
      }
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `error: ${(err as Error).message}` };
  }
}
