import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileEdit,
  FileMinus,
  FilePlus,
  FileText,
  Filter,
  Folder,
  FolderOpen,
  Search,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { ReplaceDiffEntry } from "@cmux/shared/diff-types";

// ============================================================================
// Types
// ============================================================================

type FileTreeNode = {
  name: string;
  path: string;
  children: FileTreeNode[];
  file?: ReplaceDiffEntry;
};

export type DiffSidebarFilterProps = {
  diffs: ReplaceDiffEntry[];
  viewedFiles: Set<string>;
  activePath: string;
  onSelectFile: (path: string) => void;
  onToggleViewed: (path: string) => void;
  className?: string;
};

// ============================================================================
// Constants
// ============================================================================

const SIDEBAR_WIDTH_STORAGE_KEY = "cmux:monaco-diff-sidebar:width";
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 442;

// ============================================================================
// Utilities
// ============================================================================

function clampSidebarWidth(value: number): number {
  if (Number.isNaN(value)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

function buildFileTree(files: ReplaceDiffEntry[]): FileTreeNode[] {
  const root: FileTreeNode = {
    name: "",
    path: "",
    children: [],
  };

  for (const file of files) {
    const segments = file.filePath.split("/");
    let current = root;

    segments.forEach((segment, index) => {
      const path =
        index === 0
          ? segment
          : `${current.path ? `${current.path}/` : ""}${segment}`;

      let child = current.children.find((node) => node.name === segment);

      if (!child) {
        child = {
          name: segment,
          path,
          children: [],
        };
        current.children.push(child);
      }

      if (index === segments.length - 1) {
        child.file = file;
      }

      current = child;
    });
  }

  return root.children;
}

function collectDirectoryPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];

  for (const node of nodes) {
    if (node.children.length > 0) {
      paths.push(node.path);
      paths.push(...collectDirectoryPaths(node.children));
    }
  }

  return paths;
}

function getParentPaths(path: string): string[] {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    parents.push(parts.slice(0, i).join("/"));
  }
  return parents;
}

function getStatusIcon(status: ReplaceDiffEntry["status"]) {
  const iconClass = "w-3.5 h-3.5 flex-shrink-0";
  switch (status) {
    case "added":
      return <FilePlus className={cn(iconClass, "text-green-600 dark:text-green-400")} />;
    case "deleted":
      return <FileMinus className={cn(iconClass, "text-red-600 dark:text-red-400")} />;
    case "modified":
      return <FileEdit className={cn(iconClass, "text-yellow-600 dark:text-yellow-400")} />;
    case "renamed":
      return <FileCode className={cn(iconClass, "text-blue-600 dark:text-blue-400")} />;
    default:
      return <FileText className={cn(iconClass, "text-neutral-500")} />;
  }
}

function filterTree(nodes: FileTreeNode[], filter: string): FileTreeNode[] {
  if (!filter.trim()) {
    return nodes;
  }

  const lowerFilter = filter.toLowerCase();

  const filterNode = (node: FileTreeNode): FileTreeNode | null => {
    // Check if file matches
    if (node.file) {
      const matches = node.path.toLowerCase().includes(lowerFilter);
      return matches ? node : null;
    }

    // Filter children recursively
    const filteredChildren = node.children
      .map(filterNode)
      .filter((child): child is FileTreeNode => child !== null);

    // Keep directory if it has matching children
    if (filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      };
    }

    return null;
  };

  return nodes
    .map(filterNode)
    .filter((node): node is FileTreeNode => node !== null);
}

function countFilesInTree(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.file) {
      count += 1;
    }
    count += countFilesInTree(node.children);
  }
  return count;
}

// ============================================================================
// Components
// ============================================================================

type FileTreeNavigatorProps = {
  nodes: FileTreeNode[];
  activePath: string;
  expandedPaths: Set<string>;
  viewedFiles: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleViewed: (path: string) => void;
  depth?: number;
};

const FileTreeNavigator = memo(function FileTreeNavigatorComponent({
  nodes,
  activePath,
  expandedPaths,
  viewedFiles,
  onToggleDirectory,
  onSelectFile,
  onToggleViewed,
  depth = 0,
}: FileTreeNavigatorProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const isDirectory = node.children.length > 0;
        const isExpanded = expandedPaths.has(node.path);
        const isActive = activePath === node.path;

        if (isDirectory) {
          return (
            <div key={node.path}>
              <button
                type="button"
                onClick={() => onToggleDirectory(node.path)}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800",
                  isExpanded
                    ? "text-neutral-900 dark:text-neutral-100"
                    : "text-neutral-700 dark:text-neutral-300"
                )}
                style={{ paddingLeft: depth * 14 + 10 }}
              >
                {isExpanded ? (
                  <ChevronDown
                    className="h-4 w-4 text-neutral-500 flex-shrink-0"
                    style={{ minWidth: "16px", minHeight: "16px" }}
                  />
                ) : (
                  <ChevronRight
                    className="h-4 w-4 text-neutral-500 flex-shrink-0"
                    style={{ minWidth: "16px", minHeight: "16px" }}
                  />
                )}
                {isExpanded ? (
                  <FolderOpen
                    className="h-4 w-4 text-neutral-500 flex-shrink-0 pr-0.5"
                    style={{ minWidth: "14px", minHeight: "14px" }}
                  />
                ) : (
                  <Folder
                    className="h-4 w-4 text-neutral-500 flex-shrink-0 pr-0.5"
                    style={{ minWidth: "14px", minHeight: "14px" }}
                  />
                )}
                <span className="truncate">{node.name}</span>
              </button>
              {isExpanded ? (
                <div className="mt-0.5">
                  <FileTreeNavigator
                    nodes={node.children}
                    activePath={activePath}
                    expandedPaths={expandedPaths}
                    viewedFiles={viewedFiles}
                    onToggleDirectory={onToggleDirectory}
                    onSelectFile={onSelectFile}
                    onToggleViewed={onToggleViewed}
                    depth={depth + 1}
                  />
                </div>
              ) : null}
            </div>
          );
        }

        const file = node.file;
        if (!file) {
          return null;
        }

        const isViewed = viewedFiles.has(node.path);

        return (
          <div
            key={node.path}
            className={cn(
              "group flex w-full items-center gap-1 text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800",
              isActive
                ? "bg-sky-100/80 dark:bg-sky-900/40"
                : "",
              isViewed && !isActive
                ? "opacity-60"
                : ""
            )}
            style={{ paddingLeft: depth * 14 + 10 }}
          >
            <button
              type="button"
              onClick={() => onSelectFile(node.path)}
              className={cn(
                "flex flex-1 items-center gap-1.5 py-1 text-left min-w-0",
                isActive
                  ? "text-sky-900 font-semibold dark:text-sky-100"
                  : "text-neutral-700 dark:text-neutral-300"
              )}
            >
              {getStatusIcon(file.status)}
              <span className="truncate">{node.name}</span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium pr-1">
                {file.additions > 0 && (
                  <span className="text-green-600 dark:text-green-400">
                    +{file.additions}
                  </span>
                )}
                {file.deletions > 0 && (
                  <span className="text-red-600 dark:text-red-400">
                    −{file.deletions}
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleViewed(node.path);
              }}
              className={cn(
                "flex-shrink-0 w-5 h-5 flex items-center justify-center rounded border transition-colors mr-1.5",
                isViewed
                  ? "bg-green-500 border-green-500 text-white"
                  : "border-neutral-300 dark:border-neutral-600 hover:border-neutral-400 dark:hover:border-neutral-500"
              )}
              title={isViewed ? "Mark as not viewed" : "Mark as viewed"}
            >
              {isViewed && <Check className="w-3 h-3" />}
            </button>
          </div>
        );
      })}
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

export function DiffSidebarFilter({
  diffs,
  viewedFiles,
  activePath,
  onSelectFile,
  onToggleViewed,
  className,
}: DiffSidebarFilterProps) {
  const sidebarPanelId = useId();
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [filterText, setFilterText] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const pointerStartXRef = useRef(0);
  const pointerStartWidthRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);
  const sidebarPointerMoveHandlerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const sidebarPointerUpHandlerRef = useRef<((event: PointerEvent) => void) | null>(null);

  // Sort files by path for tree building
  const sortedFiles = useMemo(() => {
    return [...diffs].sort((a, b) => {
      const aSegments = a.filePath.split("/");
      const bSegments = b.filePath.split("/");
      const minLength = Math.min(aSegments.length, bSegments.length);

      for (let i = 0; i < minLength; i += 1) {
        const aSegment = aSegments[i]!;
        const bSegment = bSegments[i]!;
        const aIsLast = i === aSegments.length - 1;
        const bIsLast = i === bSegments.length - 1;

        if (aSegment === bSegment) {
          continue;
        }

        if (aIsLast && !bIsLast) return 1;
        if (!aIsLast && bIsLast) return -1;

        return aSegment.localeCompare(bSegment);
      }

      return aSegments.length - bSegments.length;
    });
  }, [diffs]);

  const fileTree = useMemo(() => buildFileTree(sortedFiles), [sortedFiles]);
  const filteredFileTree = useMemo(
    () => filterTree(fileTree, filterText),
    [fileTree, filterText]
  );

  const directoryPaths = useMemo(
    () => collectDirectoryPaths(fileTree),
    [fileTree]
  );

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const defaults = new Set<string>(directoryPaths);
    if (activePath) {
      for (const parent of getParentPaths(activePath)) {
        defaults.add(parent);
      }
    }
    return defaults;
  });

  // Sync expanded paths when filter changes - expand all matched directories
  useEffect(() => {
    if (filterText.trim()) {
      const filteredDirPaths = collectDirectoryPaths(filteredFileTree);
      setExpandedPaths(new Set(filteredDirPaths));
    }
  }, [filterText, filteredFileTree]);

  // Load sidebar width from localStorage
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!storedWidth) {
      return;
    }
    const parsedWidth = Number.parseInt(storedWidth, 10);
    const clampedWidth = clampSidebarWidth(parsedWidth);
    setSidebarWidth((previous) =>
      previous === clampedWidth ? previous : clampedWidth
    );
  }, []);

  // Save sidebar width to localStorage
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(sidebarWidth))
    );
  }, [sidebarWidth]);

  // Cursor style during resize
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    if (!isResizingSidebar) {
      return;
    }
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [isResizingSidebar]);

  // Clean up event listeners on unmount
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    return () => {
      if (sidebarPointerMoveHandlerRef.current) {
        window.removeEventListener("pointermove", sidebarPointerMoveHandlerRef.current);
        sidebarPointerMoveHandlerRef.current = null;
      }
      if (sidebarPointerUpHandlerRef.current) {
        window.removeEventListener("pointerup", sidebarPointerUpHandlerRef.current);
        window.removeEventListener("pointercancel", sidebarPointerUpHandlerRef.current);
        sidebarPointerUpHandlerRef.current = null;
      }
    };
  }, []);

  // Expand parent paths when active path changes
  useEffect(() => {
    if (!activePath) {
      return;
    }

    setExpandedPaths((previous) => {
      const next = new Set(previous);
      for (const parent of getParentPaths(activePath)) {
        next.add(parent);
      }
      return next;
    });
  }, [activePath]);

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSidebarResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      if (typeof window === "undefined") {
        return;
      }
      event.preventDefault();
      const handleElement = event.currentTarget;
      const pointerId = event.pointerId;
      pointerStartXRef.current = event.clientX;
      pointerStartWidthRef.current = sidebarWidth;
      setIsResizingSidebar(true);

      try {
        handleElement.focus({ preventScroll: true });
      } catch {
        handleElement.focus();
      }

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - pointerStartXRef.current;
        const nextWidth = clampSidebarWidth(pointerStartWidthRef.current + delta);
        setSidebarWidth((previous) =>
          previous === nextWidth ? previous : nextWidth
        );
      };

      const handlePointerTerminate = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) {
          return;
        }
        if (handleElement.hasPointerCapture?.(pointerId)) {
          try {
            handleElement.releasePointerCapture(pointerId);
          } catch {
            // Ignore release failures.
          }
        }
        setIsResizingSidebar(false);
        if (sidebarPointerMoveHandlerRef.current) {
          window.removeEventListener("pointermove", sidebarPointerMoveHandlerRef.current);
          sidebarPointerMoveHandlerRef.current = null;
        }
        if (sidebarPointerUpHandlerRef.current) {
          window.removeEventListener("pointerup", sidebarPointerUpHandlerRef.current);
          window.removeEventListener("pointercancel", sidebarPointerUpHandlerRef.current);
          sidebarPointerUpHandlerRef.current = null;
        }
      };

      sidebarPointerMoveHandlerRef.current = handlePointerMove;
      sidebarPointerUpHandlerRef.current = handlePointerTerminate;

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerTerminate);
      window.addEventListener("pointercancel", handlePointerTerminate);

      try {
        handleElement.setPointerCapture(pointerId);
      } catch {
        // Ignore pointer capture failures (e.g., Safari).
      }
    },
    [sidebarWidth]
  );

  const handleSidebarResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const key = event.key;
      if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        const delta = key === "ArrowLeft" ? -16 : 16;
        setSidebarWidth((previous) => clampSidebarWidth(previous + delta));
        return;
      }
      if (key === "Home") {
        event.preventDefault();
        setSidebarWidth(SIDEBAR_MIN_WIDTH);
        return;
      }
      if (key === "End") {
        event.preventDefault();
        setSidebarWidth(SIDEBAR_MAX_WIDTH);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "0") {
        event.preventDefault();
        setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
      }
    },
    []
  );

  const handleSidebarResizeDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  const handleClearFilter = useCallback(() => {
    setFilterText("");
    filterInputRef.current?.focus();
  }, []);

  const totalFiles = diffs.length;
  const viewedCount = viewedFiles.size;
  const filteredCount = countFilesInTree(filteredFileTree);

  const totalAdditions = useMemo(
    () => diffs.reduce((sum, diff) => sum + (diff.additions ?? 0), 0),
    [diffs]
  );
  const totalDeletions = useMemo(
    () => diffs.reduce((sum, diff) => sum + (diff.deletions ?? 0), 0),
    [diffs]
  );

  return (
    <div className={cn("flex", className)}>
      <aside
        id={sidebarPanelId}
        className="relative flex flex-col bg-white dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800"
        style={
          {
            width: `${sidebarWidth}px`,
            minWidth: `${SIDEBAR_MIN_WIDTH}px`,
            maxWidth: `${SIDEBAR_MAX_WIDTH}px`,
          } as CSSProperties
        }
      >
        {/* Header */}
        <div className="flex-shrink-0 border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-neutral-500" />
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Files
              </span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {filterText.trim() ? `${filteredCount} / ${totalFiles}` : totalFiles}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="text-green-600 dark:text-green-400">+{totalAdditions}</span>
              <span className="text-red-600 dark:text-red-400">−{totalDeletions}</span>
            </div>
          </div>

          {/* Filter input */}
          <div className="px-3 pb-2.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-400" />
              <input
                ref={filterInputRef}
                type="text"
                placeholder="Filter files..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className={cn(
                  "w-full pl-8 pr-8 py-1.5 text-sm",
                  "bg-neutral-50 dark:bg-neutral-800",
                  "border border-neutral-200 dark:border-neutral-700",
                  "rounded-md",
                  "placeholder:text-neutral-400 dark:placeholder:text-neutral-500",
                  "text-neutral-900 dark:text-neutral-100",
                  "focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                )}
              />
              {filterText && (
                <button
                  type="button"
                  onClick={handleClearFilter}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Viewed count */}
          <div className="px-3 pb-2 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>{viewedCount} of {totalFiles} files viewed</span>
            {viewedCount > 0 && (
              <span className="text-green-600 dark:text-green-400">
                {Math.round((viewedCount / totalFiles) * 100)}%
              </span>
            )}
          </div>
        </div>

        {/* File tree */}
        <div className="flex-1 overflow-y-auto overscroll-contain py-2">
          {filteredFileTree.length > 0 ? (
            <FileTreeNavigator
              nodes={filteredFileTree}
              activePath={activePath}
              expandedPaths={expandedPaths}
              viewedFiles={viewedFiles}
              onToggleDirectory={handleToggleDirectory}
              onSelectFile={onSelectFile}
              onToggleViewed={onToggleViewed}
            />
          ) : filterText.trim() ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              No files match &ldquo;{filterText}&rdquo;
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              No files to display
            </div>
          )}
        </div>
      </aside>

      {/* Resize handle */}
      <div className="relative flex flex-none self-stretch px-1 group/resize">
        <div
          className={cn(
            "flex h-full w-full cursor-col-resize select-none items-center justify-center touch-none rounded",
            "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-500",
            isResizingSidebar
              ? "bg-sky-200/60 dark:bg-sky-900/40"
              : "bg-transparent hover:bg-sky-100/60 dark:hover:bg-sky-900/40"
          )}
          role="separator"
          aria-label="Resize file navigation panel"
          aria-orientation="vertical"
          aria-controls={sidebarPanelId}
          aria-valuenow={Math.round(sidebarWidth)}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={handleSidebarResizePointerDown}
          onKeyDown={handleSidebarResizeKeyDown}
          onDoubleClick={handleSidebarResizeDoubleClick}
        >
          <span className="sr-only">Drag to adjust file navigation width</span>
          <div
            className={cn(
              "h-full w-[3px] rounded-full transition-opacity",
              isResizingSidebar
                ? "bg-sky-500 dark:bg-sky-400 opacity-100"
                : "bg-neutral-400 opacity-0 group-hover/resize:opacity-100 dark:bg-neutral-500"
            )}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
