import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { requireBooted, adb } from "./device";
import { exec } from "../exec";

const androidInstallApk: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");
  requireBooted(allocationId);

  let apkPath = params.apkPath as string | undefined;

  // Auto-detect a freshly built APK from the build dir if not provided.
  if (!apkPath) {
    try {
      apkPath = exec(
        `find "${alloc.buildDir}" -name "*.apk" -path "*/outputs/*" 2>/dev/null | head -1`,
      ).trim();
    } catch (error) {
      console.error("android_install_apk: APK auto-detect failed", error);
    }
    if (!apkPath) {
      return { error: "No .apk found. Build first or provide apkPath." };
    }
  }

  try {
    const output = adb(`install -r "${apkPath}"`, { timeout: 180_000 });
    return { success: true, apkPath, output: output.trim() };
  } catch (error) {
    console.error("android_install_apk failed", error);
    return { error: String(error) };
  }
};

const androidLaunch: ToolHandler = async (params, allocationId) => {
  requireBooted(allocationId);

  const packageName = params.packageName as string | undefined;
  if (!packageName) {
    return { error: "packageName is required" };
  }
  const activity = params.activity as string | undefined;

  try {
    if (activity) {
      const component = activity.startsWith(".")
        ? `${packageName}/${packageName}${activity}`
        : activity.includes("/")
          ? activity
          : `${packageName}/${activity}`;
      const output = adb(`shell am start -n "${component}"`);
      return { success: true, component, output: output.trim() };
    }
    // Use the monkey trick to launch the default launcher activity.
    const output = adb(
      `shell monkey -p "${packageName}" -c android.intent.category.LAUNCHER 1`,
    );
    return { success: true, packageName, output: output.trim() };
  } catch (error) {
    console.error("android_launch failed", error);
    return { error: String(error) };
  }
};

export const appTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "android_install_apk",
      description:
        "Install an APK onto the emulator. Auto-detects a built APK from the build dir if apkPath is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          apkPath: { type: "string", description: "Path to the .apk file" },
        },
      },
    },
    handler: androidInstallApk,
  },
  {
    definition: {
      name: "android_launch",
      description: "Launch an app on the emulator by package name (and optional activity).",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name, e.g. com.example.app" },
          activity: {
            type: "string",
            description:
              "Optional activity. Accepts '.MainActivity', 'pkg/.MainActivity', or a full component.",
          },
        },
        required: ["packageName"],
      },
    },
    handler: androidLaunch,
  },
];
