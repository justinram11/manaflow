import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { exec } from "../exec";

/**
 * Find the Flutter project root (the directory containing pubspec.yaml).
 * Looks at the build dir itself first, then up to 3 levels deep.
 */
function findFlutterProjectDir(buildDir: string): string | null {
  try {
    const output = exec(
      `find "${buildDir}" -maxdepth 4 -name "pubspec.yaml" -not -path "*/.dart_tool/*" -not -path "*/build/*" 2>/dev/null | head -1`,
    ).trim();
    if (!output) return null;
    return output.replace(/\/pubspec\.yaml$/, "");
  } catch {
    return null;
  }
}

/**
 * Detect whether the project pins a specific Flutter version. Looks at
 * .fvmrc (modern), .fvm/fvm_config.json (legacy), then falls back to
 * parsing android/local.properties for a flutter.sdk path that lives
 * inside an fvm/versions/<X.Y.Z>/ directory (common when the user runs
 * `fvm use X.Y.Z` locally but doesn't commit .fvmrc).
 */
function detectFlutterVersion(projectDir: string): string | null {
  try {
    const content = exec(`cat "${projectDir}/.fvmrc" 2>/dev/null`).trim();
    if (content) {
      const parsed = JSON.parse(content) as { flutter?: string };
      if (parsed.flutter) return parsed.flutter;
    }
  } catch {
    /* ignore */
  }
  try {
    const content = exec(
      `cat "${projectDir}/.fvm/fvm_config.json" 2>/dev/null`,
    ).trim();
    if (content) {
      const parsed = JSON.parse(content) as { flutterSdkVersion?: string };
      if (parsed.flutterSdkVersion) return parsed.flutterSdkVersion;
    }
  } catch {
    /* ignore */
  }
  try {
    const content = exec(
      `cat "${projectDir}/android/local.properties" 2>/dev/null`,
    );
    const match = content.match(/flutter\.sdk=.*?\/fvm\/versions\/([^/\s]+)/);
    if (match) return match[1];
  } catch {
    /* ignore */
  }
  return null;
}

/** Locate the most-recently-built APK in <projectDir>/build/app/outputs. */
function findBuiltApk(projectDir: string): string | null {
  try {
    const output = exec(
      `find "${projectDir}/build" -name "*.apk" -path "*/outputs/*" 2>/dev/null | head -1`,
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

const androidBuildFlutter: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const projectDir =
    (params.projectDir as string | undefined) ?? findFlutterProjectDir(alloc.buildDir);
  if (!projectDir) {
    return {
      error:
        "No Flutter project (pubspec.yaml) found in build dir. Run android_sync_code first, or pass projectDir.",
    };
  }

  const flavor = params.flavor as string | undefined;
  const buildMode = (params.buildMode as string | undefined) ?? "debug";
  const dartDefines = (params.dartDefines as Record<string, string> | undefined) ?? {};

  const dartDefineArgs = Object.entries(dartDefines)
    .map(([k, v]) => `--dart-define=${k}=${String(v).replace(/"/g, '\\"')}`)
    .join(" ");

  const flavorArg = flavor ? ` --flavor "${flavor}"` : "";

  // If the project pins a Flutter version (via .fvmrc, .fvm/fvm_config.json,
  // or an fvm path in android/local.properties), use `fvm flutter` so the
  // build uses the project's pinned SDK rather than the image's default
  // /opt/flutter. fvm downloads versions on demand; 3.38.4 is pre-cached
  // in the image. `flutterVersion` param overrides detection.
  const detectedFlutterVersion =
    (params.flutterVersion as string | undefined) ?? detectFlutterVersion(projectDir);
  const useFvm = Boolean(detectedFlutterVersion);
  // /opt/flutter/bin is added to PATH by the image, but the in-VM MCP server
  // runs under a systemd unit with a hard-coded PATH that doesn't include it.
  // Use absolute paths so the build works regardless of how PATH is set.
  const flutter = useFvm
    ? "/root/.pub-cache/bin/fvm flutter"
    : process.env.CMUX_FLUTTER_BIN ?? "/opt/flutter/bin/flutter";
  const dart = useFvm
    ? "/root/.pub-cache/bin/fvm dart"
    : process.env.CMUX_DART_BIN ?? "/opt/flutter/bin/dart";

  // Auto-detect projects that use code generation (freezed / json_serializable
  // / drift / hive). Without build_runner, `flutter build apk` errors out at
  // dart compilation with "getter X isn't defined" on the *.g.dart accessors.
  // `runBuildRunner: false` opts out; pass it for projects where you've
  // already run build_runner and want to skip the cache-warming run.
  const skipBuildRunner = params.runBuildRunner === false;
  let needsBuildRunner = false;
  if (!skipBuildRunner) {
    try {
      const pubspec = exec(`cat "${projectDir}/pubspec.yaml"`).toString();
      needsBuildRunner = /\bbuild_runner\s*:/i.test(pubspec);
    } catch {
      /* ignore */
    }
  }

  // When using fvm, ensure the pinned version is installed locally and
  // pinned for this project (writes .fvmrc if missing). Idempotent: fvm
  // skips if the version is already cached.
  const fvmSetupCmds = useFvm
    ? [
        `/root/.pub-cache/bin/fvm install ${detectedFlutterVersion} --no-setup`,
        `/root/.pub-cache/bin/fvm use ${detectedFlutterVersion} --force`,
      ]
    : [];

  const cmd = [
    `cd "${projectDir}"`,
    ...fvmSetupCmds,
    // `flutter pub get` is fast when already cached; rerun on every sync so
    // newly added deps land before the build.
    `${flutter} pub get`,
    ...(needsBuildRunner
      ? [`${dart} run build_runner build --delete-conflicting-outputs`]
      : []),
    `${flutter} build apk --${buildMode}${flavorArg} ${dartDefineArgs}`.trim(),
  ].join(" && ");

  console.log(`[android_build_flutter] ${cmd}`);

  try {
    const output = exec(cmd, { timeout: 20 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    const apkPath = findBuiltApk(projectDir);
    return {
      success: true,
      projectDir,
      apkPath,
      output: output.slice(-4000),
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    console.error("[android_build_flutter] failed", err.stderr ?? err.stdout ?? error);
    return {
      success: false,
      projectDir,
      output: (err.stdout ?? "").slice(-4000),
      error: (err.stderr ?? String(error)).slice(-4000),
      exitCode: err.status,
    };
  }
};

export const buildTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "android_build_flutter",
      description:
        "Build a Flutter app inside the android container. Auto-detects pubspec.yaml under the build dir. Returns the path to the built APK. Call android_sync_code first.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: {
            type: "string",
            description: "Path to the Flutter project root (containing pubspec.yaml). Auto-detected if omitted.",
          },
          buildMode: {
            type: "string",
            enum: ["debug", "profile", "release"],
            description: "Build mode (default: debug)",
          },
          flavor: {
            type: "string",
            description: "Optional flutter flavor",
          },
          dartDefines: {
            type: "object",
            description: "Key/value pairs passed as --dart-define=KEY=VALUE. Use this to inject e.g. API_BASE_URL.",
            additionalProperties: { type: "string" },
          },
          runBuildRunner: {
            type: "boolean",
            description: "Run `dart run build_runner build --delete-conflicting-outputs` before the flutter build. Auto-enabled when pubspec.yaml declares a build_runner dependency.",
          },
          flutterVersion: {
            type: "string",
            description: "Pin a Flutter version via fvm (e.g. \"3.38.4\"). If omitted, auto-detected from .fvmrc / .fvm/fvm_config.json / android/local.properties; falls back to the image's default flutter when nothing pins.",
          },
        },
      },
    },
    handler: androidBuildFlutter,
  },
];
