import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { execInVm } from "../tart-vm";
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

function findXcodeProject(vmName: string, buildDir: string): XcodeProject | null {
  try {
    const output = execInVm(
      vmName,
      `find "${buildDir}" -maxdepth 4 \\( -name "*.xcworkspace" -o -name "*.xcodeproj" \\) -not -path "*/DerivedData/*" -not -path "*/.git/*" -not -path "*/Pods/*" 2>/dev/null | sort`,
    );

    const paths = output.trim().split("\n").filter(Boolean);
    if (paths.length === 0) return null;

    const preferredDirs = ["", "ios"];
    const matches: XcodeProject[] = paths.map((p) => ({
      path: p,
      projectDir: p.replace(/\/[^/]+\.(xcworkspace|xcodeproj)$/, ""),
      type: (p.endsWith(".xcworkspace") ? "workspace" : "project") as "workspace" | "project",
    }));

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
  } catch {
    return null;
  }
}

function getDerivedDataPath(buildDir: string): string {
  return `${buildDir}/DerivedData`;
}

function getXcodeBuildBase(
  vmName: string,
  buildDir: string,
  scheme?: string,
): { args: string[]; projectDir: string } {
  const project = findXcodeProject(vmName, buildDir);
  const args = ["xcodebuild"];
  if (project) {
    if (project.type === "workspace") {
      args.push("-workspace", `"${project.path}"`);
    } else {
      args.push("-project", `"${project.path}"`);
    }
    args.push("-derivedDataPath", `"${getDerivedDataPath(buildDir)}"`);
  }
  if (scheme) args.push("-scheme", `"${scheme}"`);
  return { args, projectDir: project?.projectDir ?? buildDir };
}

const iosBuild: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  return buildLimit(async () => {
    const { args, projectDir } = getXcodeBuildBase(
      alloc.tartVmName,
      alloc.buildDir,
      params.scheme as string | undefined,
    );
    args.push("build");

    if (params.configuration) args.push("-configuration", params.configuration as string);
    if (params.destination) {
      args.push("-destination", `'${params.destination as string}'`);
    } else if (alloc.simulatorUdid) {
      args.push("-destination", `'platform=iOS Simulator,id=${alloc.simulatorUdid}'`);
    }
    if (params.extraArgs) {
      args.push(...(params.extraArgs as string[]));
    }

    const cmd = `cd "${projectDir}" && ${args.join(" ")}`;
    console.log(`Running in VM ${alloc.tartVmName}: ${cmd}`);

    try {
      const output = execInVm(alloc.tartVmName, cmd, {
        timeout: 30 * 60 * 1000,
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
      alloc.tartVmName,
      alloc.buildDir,
      params.scheme as string | undefined,
    );
    args.push("build");
    if (params.configuration) args.push("-configuration", params.configuration as string);
    args.push("-destination", `'platform=iOS Simulator,id=${alloc.simulatorUdid}'`);

    const cmd = `cd "${projectDir}" && ${args.join(" ")}`;
    console.log(`Running in VM ${alloc.tartVmName}: ${cmd}`);

    try {
      const output = execInVm(alloc.tartVmName, cmd, {
        timeout: 30 * 60 * 1000,
      });

      // Find .app in DerivedData and install
      const derivedDataBase = getDerivedDataPath(alloc.buildDir);
      let appPath = "";
      try {
        const found = execInVm(
          alloc.tartVmName,
          `find "${derivedDataBase}" -name "*.app" -path "*/Build/Products/*" 2>/dev/null | head -1`,
        ).trim();
        if (found) appPath = found;
      } catch {
        // Ignore
      }

      if (appPath) {
        execInVm(alloc.tartVmName, `xcrun simctl install "${alloc.simulatorUdid}" "${appPath}"`);

        // Get bundle ID from Info.plist
        try {
          const bundleId = execInVm(
            alloc.tartVmName,
            `/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${appPath}/Info.plist"`,
          ).trim();
          execInVm(alloc.tartVmName, `xcrun simctl launch "${alloc.simulatorUdid}" "${bundleId}"`);
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
    alloc.tartVmName,
    alloc.buildDir,
    params.scheme as string | undefined,
  );
  args.push("clean");

  try {
    const output = execInVm(alloc.tartVmName, `cd "${projectDir}" && ${args.join(" ")}`);
    return { success: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { success: false, error: err.stderr ?? String(error) };
  }
};

const iosListSchemes: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const project = findXcodeProject(alloc.tartVmName, alloc.buildDir);
  if (!project) return { schemes: [], error: "No Xcode project found" };

  const flag = project.type === "workspace" ? "-workspace" : "-project";
  try {
    const output = execInVm(
      alloc.tartVmName,
      `cd "${project.projectDir}" && xcodebuild -list ${flag} "${project.path}"`,
    );
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
    const project = findXcodeProject(alloc.tartVmName, alloc.buildDir);
    if (!project) return { error: "No Xcode project found" };

    const flag = project.type === "workspace" ? "-workspace" : "-project";
    try {
      const output = execInVm(
        alloc.tartVmName,
        `cd "${project.projectDir}" && xcodebuild -resolvePackageDependencies ${flag} "${project.path}" -derivedDataPath "${getDerivedDataPath(alloc.buildDir)}"`,
        { timeout: 10 * 60 * 1000 },
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
