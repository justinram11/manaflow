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

type XcodeProject = {
  path: string;
  projectDir: string;
  type: "workspace" | "project";
};

function findXcodeProject(buildDir: string): XcodeProject | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: buildDir, depth: 0 }];
  const preferredDirs = ["", "ios"];
  const matches: XcodeProject[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    const entries = readdirSync(current.dir, { withFileTypes: true });
    const workspace = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"));
    if (workspace) {
      matches.push({
        path: join(current.dir, workspace.name),
        projectDir: current.dir,
        type: "workspace",
      });
    }

    const project = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
    if (project) {
      matches.push({
        path: join(current.dir, project.name),
        projectDir: current.dir,
        type: "project",
      });
    }

    if (current.depth >= 3) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === "DerivedData") continue;
      if (entry.name.endsWith(".xcworkspace") || entry.name.endsWith(".xcodeproj")) continue;
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  matches.sort((left, right) => {
    const leftRelative = left.projectDir.slice(buildDir.length).replace(/^\//, "");
    const rightRelative = right.projectDir.slice(buildDir.length).replace(/^\//, "");
    const leftRank = preferredDirs.indexOf(leftRelative);
    const rightRank = preferredDirs.indexOf(rightRelative);
    const normalizedLeftRank = leftRank === -1 ? preferredDirs.length : leftRank;
    const normalizedRightRank = rightRank === -1 ? preferredDirs.length : rightRank;
    if (normalizedLeftRank !== normalizedRightRank) {
      return normalizedLeftRank - normalizedRightRank;
    }
    return left.path.localeCompare(right.path);
  });

  return matches[0] ?? null;
}

function getDerivedDataPath(buildDir: string): string {
  return join(buildDir, "DerivedData");
}

function getXcodeBuildBase(
  buildDir: string,
  scheme?: string,
): { args: string[]; projectDir: string } {
  const project = findXcodeProject(buildDir);
  const args = ["xcodebuild"];
  if (project) {
    if (project.type === "workspace") {
      args.push("-workspace", project.path);
    } else {
      args.push("-project", project.path);
    }
    args.push("-derivedDataPath", getDerivedDataPath(buildDir));
  }
  if (scheme) args.push("-scheme", scheme);
  return { args, projectDir: project?.projectDir ?? buildDir };
}

const iosBuild: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  return buildLimit(async () => {
    const { args, projectDir } = getXcodeBuildBase(
      alloc.buildDir,
      params.scheme as string | undefined,
    );
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
        cwd: projectDir,
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
    const { args, projectDir } = getXcodeBuildBase(
      alloc.buildDir,
      params.scheme as string | undefined,
    );
    args.push("build");
    if (params.configuration) args.push("-configuration", params.configuration as string);
    args.push("-destination", `platform=iOS Simulator,id=${alloc.simulatorUdid}`);

    const cmd = args.join(" ");
    console.log(`Running: ${cmd}`);

    try {
      const output = execSync(cmd, {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: 30 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });

      // Find .app in DerivedData and install
      const derivedDataBase = getDerivedDataPath(alloc.buildDir);
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

  const { args, projectDir } = getXcodeBuildBase(
    alloc.buildDir,
    params.scheme as string | undefined,
  );
  args.push("clean");

  try {
    const output = execSync(args.join(" "), { cwd: projectDir, encoding: "utf-8" });
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
      cwd: project.projectDir,
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
        `xcodebuild -resolvePackageDependencies ${flag} "${project.path}" -derivedDataPath "${getDerivedDataPath(alloc.buildDir)}"`,
        { cwd: project.projectDir, encoding: "utf-8", timeout: 10 * 60 * 1000 },
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
        "Build an Xcode project in the workspace. Auto-detects .xcworkspace or .xcodeproj. Uses the workspace's assigned simulator destination by default when available. Prefer the repo's Debug configuration for local simulator work. Queued (respects maxConcurrentBuilds).",
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
        "Build, install, and launch the app on the workspace's simulator using the repo's local simulator configuration. Prefer this over manually forcing code signing or SDK overrides. Queued.",
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
