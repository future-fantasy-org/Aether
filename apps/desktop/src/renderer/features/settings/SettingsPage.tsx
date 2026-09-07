import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type AppSettings } from "@aether/desktop-contracts";
import { app } from "../../api/client.js";
import { useUiStore } from "../../stores/ui.js";

/** Settings modal: DeepSeek key (UI-only, per user decision), codex, approvals. */
export default function SettingsPage() {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    app
      .request("settings/get")
      .then((s) => setSettings(s as AppSettings))
      .catch((err: Error) => setError(err.message));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const next = (await app.request("settings/set", settings)) as AppSettings;
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded border border-[#232b3c] bg-[#111622] px-2 py-1.5 text-[12.5px] text-[#dbe2ec] outline-none focus:border-[#1f6feb]";
  const label = "mb-1 block text-[11.5px] font-medium text-[#8b96a8]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSettingsOpen(false)}>
      <div
        className="max-h-[80%] w-[520px] overflow-y-auto rounded-lg border border-[#232b3c] bg-[#0d1119] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-white">Settings</h2>
          <button className="text-[16px] text-[#8b96a8] hover:text-white" onClick={() => setSettingsOpen(false)}>
            ×
          </button>
        </div>

        {error && <p className="mb-3 rounded bg-[#ff7b72]/10 px-2 py-1 text-[12px] text-[#ff7b72]">{error}</p>}

        <fieldset className="mb-4">
          <legend className="mb-2 text-[12px] font-semibold text-[#4a9eff]">DeepSeek</legend>
          <label className={label}>API Key</label>
          <div className="flex gap-1.5">
            <input
              className={field}
              type={showKey ? "text" : "password"}
              placeholder="sk-..."
              value={settings.deepseekApiKey}
              onChange={(e) => setSettings({ ...settings, deepseekApiKey: e.target.value })}
            />
            <button
              className="rounded border border-[#232b3c] px-2 text-[11px] text-[#8b96a8] hover:bg-[#1c2230]"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-[#5c6b7f]">
            Stored locally by the desktop app; injected into the agent host in memory only.
          </p>
          <label className={`${label} mt-3`}>Model</label>
          <select
            className={field}
            value={settings.deepseekModel}
            onChange={(e) =>
              setSettings({ ...settings, deepseekModel: e.target.value as AppSettings["deepseekModel"] })
            }
          >
            <option value="deepseek-chat">deepseek-chat</option>
            <option value="deepseek-reasoner">deepseek-reasoner</option>
          </select>
          <label className={`${label} mt-3`}>API Base URL</label>
          <input
            className={field}
            value={settings.deepseekBaseUrl}
            onChange={(e) => setSettings({ ...settings, deepseekBaseUrl: e.target.value })}
          />
        </fieldset>

        <fieldset className="mb-4">
          <legend className="mb-2 text-[12px] font-semibold text-[#4ade80]">Codex</legend>
          <label className={label}>Command</label>
          <input
            className={field}
            value={settings.codexCommand}
            placeholder="codex"
            onChange={(e) => setSettings({ ...settings, codexCommand: e.target.value })}
          />
          <label className={`${label} mt-3`}>Model override (optional)</label>
          <input
            className={field}
            value={settings.codexModel}
            placeholder="use codex default"
            onChange={(e) => setSettings({ ...settings, codexModel: e.target.value })}
          />
        </fieldset>

        <fieldset className="mb-5">
          <legend className="mb-2 text-[12px] font-semibold text-[#e3b341]">Approvals</legend>
          <label className={label}>Default policy for new threads</label>
          <select
            className={field}
            value={settings.approvalMode}
            onChange={(e) =>
              setSettings({ ...settings, approvalMode: e.target.value as AppSettings["approvalMode"] })
            }
          >
            <option value="askAlways">Ask for every command</option>
            <option value="askDangerous">Ask for risky commands only</option>
            <option value="never">Never ask</option>
          </select>
        </fieldset>

        <div className="flex justify-end gap-2">
          {saved && <span className="self-center text-[12px] text-[#4ade80]">Saved ✓</span>}
          <button
            className="rounded border border-[#2a3140] px-3 py-1.5 text-[12.5px] text-[#aab3c2] hover:bg-[#1c2230]"
            onClick={() => setSettingsOpen(false)}
          >
            Close
          </button>
          <button
            className="rounded bg-[#1f6feb] px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-[#388bfd] disabled:opacity-40"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
