import { execSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import pLimit from "p-limit";

// Build concurrency limiter - will be set from config
let buildLimit = pLimit(2);

export function setBuildConcurrency(max: number) {
  buildLimit = pLimit(max);
}

function findXcodeProject(buildDir: string): { path: string; type: "workspace" | "project" } | null {
  const entries = readdirSync(buildDir);
  // Prefer .xcworkspace over .xcodeproj
  const workspace = entries.find((e) => e.endsWith(".xcworkspace"));
  if (workspace) return { path: join(buildDir, workspace), type: "workspace" };
  const project = entries.find((e) => e.endsWith(".xcodeproj"));
  if (project) return { path: join(buildDir, project), type: "project" };
  return null;
}

function getXcodeBuildBase(buildDir: string, scheme?: string): string[] {
  const project = findXcodeProject(buildDir);
  const args = ["xcodebuild"];
  if (project) {
    if (project.type === "workspace") {
      args.push("-workspace", project.path);
    } else {
      args.push("-project", project.path);
    }
  }
  if (scheme) args.push("-scheme", scheme);
  return args;
}

const iosBuild: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  return buildLimit(async () => {
    const args = getXcodeBuildBase(alloc.buildDir, params.scheme as string | undefined);
    args.push("build");

    if (params.configuration) args.push("-configuration", params.configuration as string);
    if (params.destination) {
      args.push("-destination", params.destination as string);
    } else if (alloc.simulatorUdid) {
      args.push("-destination", `platform=iOS Simulator,id=${alloc.simulatorUdid}`);
    }
    if (params.extraArgs) {
      args.push(...(params.extraArgs as string[]));
    }

    const cmd = args.join(" ");
    console.log(`Running: ${cmd}`);

    try {
      const output = execSync(cmd, {
        cwd: alloc.buildDir,
        encoding: "utf-8",
        timeout: 30 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });
      return { success: true, output };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; status?: number };
      return {
        success: false,
        output: err.stdout ?? "",
        error: err.stderr ?? "",
        exitCode: err.status,
      };
    }
  });
};

const iosBuildAndRun: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");
  if (!alloc.simulatorUdid) throw new Error("No simulator assigned to allocation");

  return buildLimit(async () => {
    const args = getXcodeBuildBase(alloc.buildDir, params.scheme as string | undefined);
    args.push("build");
    if (params.configuration) args.push("-configuration", params.configuration as string);
    args.push("-destination", `platform=iOS Simulator,id=${alloc.simulatorUdid}`);

    const cmd = args.join(" ");
    console.log(`Running: ${cmd}`);

    try {
      const output = execSync(cmd, {
        cwd: alloc.buildDir,
        encoding: "utf-8",
        timeout: 30 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });

      // Find .app in DerivedData and install
      const derivedDataBase = join(alloc.buildDir, "DerivedData");
      let appPath = "";
      if (existsSync(derivedDataBase)) {
        try {
          const found = execSync(
            `find "${derivedDataBase}" -name "*.app" -path "*/Build/Products/*" | head -1`,
            { encoding: "utf-8" },
          ).trim();
          if (found) appPath = found;
        } catch {
          // Ignore
        }
      }

      if (appPath) {
        execSync(`xcrun simctl install "${alloc.simulatorUdid}" "${appPath}"`, { encoding: "utf-8" });

        // Get bundle ID from Info.plist
        try {
          const bundleId = execSync(
            `/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${appPath}/Info.plist"`,
            { encoding: "utf-8" },
          ).trim();
          execSync(`xcrun simctl launch "${alloc.simulatorUdid}" "${bundleId}"`, { encoding: "utf-8" });
          return { success: true, output, bundleId, appPath };
        } catch (launchErr) {
          return { success: true, output, appPath, launchError: String(launchErr) };
        }
      }

      return { success: true, output, warning: "Could not find .app to install" };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; status?: number };
      return {
        success: false,
        output: err.stdout ?? "",
        error: err.stderr ?? "",
        exitCode: err.status,
      };
    }
  });
};

const iosClean: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const args = getXcodeBuildBase(alloc.buildDir, params.scheme as string | undefined);
  args.push("clean");

  try {
    const output = execSync(args.join(" "), { cwd: alloc.buildDir, encoding: "utf-8" });
    return { success: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { success: false, error: err.stderr ?? String(error) };
  }
};

const iosListSchemes: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const project = findXcodeProject(alloc.buildDir);
  if (!project) return { schemes: [], error: "No Xcode project found" };

  const flag = project.type === "workspace" ? "-workspace" : "-project";
  try {
    const output = execSync(`xcodebuild -list ${flag} "${project.path}"`, {
      cwd: alloc.buildDir,
      encoding: "utf-8",
    });
    return { output };
  } catch (error) {
    const err = error as { stderr?: string };
    return { error: err.stderr ?? String(error) };
  }
};

const iosResolvePackages: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  return buildLimit(async () => {
    const project = findXcodeProject(alloc.buildDir);
    if (!project) return { error: "No Xcode project found" };

    const flag = project.type === "workspace" ? "-workspace" : "-project";
    try {
      const output = execSync(
        `xcodebuild -resolvePackageDependencies ${flag} "${project.path}"`,
        { cwd: alloc.buildDir, encoding: "utf-8", timeout: 10 * 60 * 1000 },
      );
      return { success: true, output };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return { success: false, error: err.stderr ?? String(error) };
    }
  });
};

export const buildTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_build",
      description:
        "Build an Xcode project in the workspace. Auto-detects .xcworkspace or .xcodeproj. Queued (respects maxConcurrentBuilds).",
      inputSchema: {
        type: "object",
        properties: {
          scheme: { type: "string", description: "Xcode scheme to build" },
          configuration: { type: "string", enum: ["Debug", "Release"], description: "Build configuration" },
          destination: { type: "string", description: "Xcodebuild destination string" },
          extraArgs: { type: "array", items: { type: "string" }, description: "Extra xcodebuild arguments" },
        },
      },
    },
    handler: iosBuild,
  },
  {
    definition: {
      name: "ios_build_and_run",
      description:
        "Build, install, and launch the app on the workspace's simulator. Queued.",
      inputSchema: {
        type: "object",
        properties: {
          scheme: { type: "string", description: "Xcode scheme to build" },
          configuration: { type: "string", enum: ["Debug", "Release"], description: "Build configuration" },
        },
      },
    },
    handler: iosBuildAndRun,
  },
  {
    definition: {
      name: "ios_clean",
      description: "Run xcodebuild clean in the workspace's build directory.",
      inputSchema: {
        type: "object",
        properties: {
          scheme: { type: "string", description: "Xcode scheme to clean" },
        },
      },
    },
    handler: iosClean,
  },
  {
    definition: {
      name: "ios_list_schemes",
      description: "List available Xcode schemes in the workspace.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: iosListSchemes,
  },
  {
    definition: {
      name: "ios_resolve_packages",
      description: "Resolve Swift Package Manager dependencies. Queued.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: iosResolvePackages,
  },
];
