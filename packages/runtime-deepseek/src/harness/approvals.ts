/** Shell command risk classification for approval gating. */

export type ApprovalMode = "askAlways" | "askDangerous" | "never";
export type Risk = "low" | "medium" | "high";

const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/, // rm -rf any order
  /rm\s+-[a-zA-Z]*r/, // rm -r broadly
  /\bsudo\b/,
  /mkfs/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /curl[^|]*\|\s*(ba|z)?sh/,
  /wget[^|]*\|\s*(ba|z)?sh/,
  /git\s+push\s+.*--force/,
  /chmod\s+777/,
  /:\(\)\{\s*:\|:&\s*\};/, // fork bomb
];

const READONLY_PATTERNS: RegExp[] = [
  /^(ls|cat|head|tail|wc|file|which|where|pwd|echo|date|whoami|uname)\b/,
  /^grep\b/,
  /^rg\b/,
  /^find\b/,
  /^git\s+(status|diff|log|show|branch|remote)\b/,
  /^npm\s+(ls|run\s+--list|test)\b/,
  /^pnpm\s+(ls|test)\b/,
  /^node\s+--version/,
  /^python3?\s+--version/,
];

export interface RiskAssessment {
  risk: Risk;
  needsApproval: boolean;
}

/** Classify a shell command and decide whether approval is required. */
export function shellRisk(command: string, mode: ApprovalMode): RiskAssessment {
  const cmd = command.trim();
  const dangerous = DANGEROUS_PATTERNS.some((re) => re.test(cmd));
  const readonly = READONLY_PATTERNS.some((re) => re.test(cmd));

  let risk: Risk;
  if (dangerous) risk = "high";
  else if (readonly) risk = "low";
  else risk = "medium";

  const needsApproval =
    mode === "never"
      ? false
      : mode === "askAlways"
        ? true
        : risk !== "low";
  return { risk, needsApproval };
}
