import { create } from "zustand";

export type SurfaceKind = "files" | "diff" | "terminal" | "artifact" | "inspector";

export interface Surface {
  id: string;
  kind: SurfaceKind;
  title: string;
  props: Record<string, unknown>;
  pinned: boolean;
}

interface UiStore {
  selectedWorkspaceId: string | undefined;
  selectedThreadId: string | undefined;
  surfaces: Surface[];
  activeSurfaceId: string | undefined;
  surfaceOpen: boolean;
  settingsOpen: boolean;
  selectWorkspace(id: string | undefined): void;
  selectThread(id: string | undefined): void;
  openSurface(s: Omit<Surface, "pinned">, opts?: { replace?: boolean }): void;
  closeSurface(id: string): void;
  togglePin(id: string): void;
  setActiveSurface(id: string): void;
  setSurfaceOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
}

export const useUiStore = create<UiStore>((set) => ({
  selectedWorkspaceId: undefined,
  selectedThreadId: undefined,
  surfaces: [],
  activeSurfaceId: undefined,
  surfaceOpen: true,
  settingsOpen: false,

  selectWorkspace: (id) => set({ selectedWorkspaceId: id, selectedThreadId: undefined }),
  selectThread: (id) => set({ selectedThreadId: id }),

  openSurface: (s, opts) =>
    set((state) => {
      const existing = state.surfaces.find((x) => x.id === s.id);
      if (existing) {
        return { activeSurfaceId: s.id, surfaceOpen: true, surfaces: state.surfaces.map((x) => (x.id === s.id ? { ...x, props: s.props } : x)) };
      }
      // Replace the last unpinned surface to avoid unbounded tabs.
      const replaceable =
        opts?.replace !== false ? [...state.surfaces].reverse().find((x) => !x.pinned) : undefined;
      const surfaces = replaceable
        ? state.surfaces.map((x) => (x.id === replaceable.id ? { ...s, pinned: false } : x))
        : [...state.surfaces, { ...s, pinned: false }];
      return { surfaces, activeSurfaceId: s.id, surfaceOpen: true };
    }),

  closeSurface: (id) =>
    set((state) => {
      const surfaces = state.surfaces.filter((s) => s.id !== id);
      const activeSurfaceId =
        state.activeSurfaceId === id ? surfaces.at(-1)?.id : state.activeSurfaceId;
      return { surfaces, activeSurfaceId, surfaceOpen: surfaces.length > 0 };
    }),

  togglePin: (id) =>
    set((state) => ({
      surfaces: state.surfaces.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
    })),

  setActiveSurface: (id) => set({ activeSurfaceId: id, surfaceOpen: true }),
  setSurfaceOpen: (open) => set({ surfaceOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));
