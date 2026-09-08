import type { ForgeConfig } from "@electron-forge/shared-types";
import path from "node:path";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP as MakerZip } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { VitePlugin } from "@electron-forge/plugin-vite";

// macOS signing/notarization activate only when APPLE_* env vars are present
// (release workflow exports them when the repo has the secrets configured);
// local and unsigned CI builds skip signing entirely.
const macIdentity = process.env.APPLE_SIGNING_IDENTITY;
const macNotarizeCreds =
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
    ? ({
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      } as never)
    : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    // Host sidecar runtime is materialized by scripts/package-prepare.mjs
    // (pnpm deploy of @aether/agent-runtime-host) and shipped as an extra
    // resource so the packaged app can spawn it with ELECTRON_RUN_AS_NODE.
    // NOTE: @electron/packager takes `extraResource` (array of paths, copied
    // to Resources/<basename>); the {from, to} form is electron-builder only.
    extraResource: [path.resolve(__dirname, ".pack/aether-agent-host")],
    ...(macIdentity
      ? {
          osxSign: {
            identity: macIdentity,
            "hardened-runtime": true,
            entitlements: "entitlements.mac.plist",
            "entitlements-inherit": "entitlements.mac.plist",
          },
          osxNotarize: macNotarizeCreds,
        }
      : {}),
    appCategoryType: "public.app-category.developer-tools",
  },
  rebuildConfig: {},
  makers: [
    new MakerZip({}, ["darwin"]),
    new MakerDMG({
      format: "UDZO",
    }),
    new MakerSquirrel({
      // Windows code signing activates when WINDOWS_SIGNING_* secrets exist.
      ...(process.env.WINDOWS_SIGNING_CERTIFICATE_FILE
        ? {
            signWithParams: `/f "${process.env.WINDOWS_SIGNING_CERTIFICATE_FILE}" /p "${process.env.WINDOWS_SIGNING_CERTIFICATE_PASSWORD}" /fd sha256 /tr http://timestamp.digicert.com /td sha256`,
          }
        : {}),
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
  ],
};

export default config;
