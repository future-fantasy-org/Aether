export interface TerminalSession {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onOutput(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export interface TerminalProvider {
  create(cwd?: string): Promise<TerminalSession>;
  get(id: string): TerminalSession | undefined;
  dispose(id: string): void;
}
