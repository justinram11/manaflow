import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Id } from "@cmux/convex/dataModel";

type ScreenshotStatus = "completed" | "failed" | "skipped";

interface ScreenshotImage {
  storageId: Id<"_storage">;
  mimeType: string;
  fileName?: string | null;
  commitSha?: string | null;
  url?: string | null;
}

interface RunScreenshotSet {
  _id: Id<"taskRunScreenshotSets">;
  taskId: Id<"tasks">;
  runId: Id<"taskRuns">;
  status: ScreenshotStatus;
  commitSha?: string | null;
  capturedAt: number;
  error?: string | null;
  images: ScreenshotImage[];
}

interface RunScreenshotGalleryProps {
  screenshotSets: RunScreenshotSet[];
  highlightedSetId?: Id<"taskRunScreenshotSets"> | null;
}

const STATUS_LABELS: Record<ScreenshotStatus, string> = {
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_STYLES: Record<ScreenshotStatus, string> = {
  completed:
    "bg-emerald-100/70 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  failed: "bg-rose-100/70 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  skipped:
    "bg-neutral-200/70 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

export function RunScreenshotGallery(props: RunScreenshotGalleryProps) {
  const { screenshotSets, highlightedSetId } = props;
  if (!screenshotSets || screenshotSets.length === 0) {
    return null;
  }
  return (
    <RunScreenshotGalleryContent
      screenshotSets={screenshotSets}
      highlightedSetId={highlightedSetId}
    />
  );
}

interface RunScreenshotGalleryContentProps {
  screenshotSets: RunScreenshotSet[];
  highlightedSetId?: Id<"taskRunScreenshotSets"> | null;
}

function RunScreenshotGalleryContent(props: RunScreenshotGalleryContentProps) {
  const { screenshotSets, highlightedSetId } = props;
  const sortedScreenshotSets = useMemo(
    () =>
      [...screenshotSets].sort((a, b) => {
        if (a.capturedAt === b.capturedAt) {
          return a._id.localeCompare(b._id);
        }
        return a.capturedAt - b.capturedAt;
      }),
    [screenshotSets],
  );

  const flattenedImages = useMemo(
    () =>
      sortedScreenshotSets.flatMap((set) =>
        set.images.flatMap((image, indexInSet) =>
          image.url
            ? [
                {
                  set,
                  image,
                  indexInSet,
                },
              ]
            : [],
        ),
      ),
    [sortedScreenshotSets],
  );

  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null);

  const currentEntry =
    activeImageIndex !== null &&
    activeImageIndex >= 0 &&
    activeImageIndex < flattenedImages.length
      ? flattenedImages[activeImageIndex]
      : null;

  const effectiveHighlight =
    highlightedSetId ??
    currentEntry?.set._id ??
    sortedScreenshotSets[sortedScreenshotSets.length - 1]?._id;

  useEffect(() => {
    if (activeImageIndex === null) {
      return;
    }
    if (flattenedImages.length === 0) {
      setActiveImageIndex(null);
      return;
    }
    if (activeImageIndex >= flattenedImages.length) {
      setActiveImageIndex(flattenedImages.length - 1);
    }
  }, [activeImageIndex, flattenedImages.length]);

  const closeSlideshow = useCallback(() => {
    setActiveImageIndex(null);
  }, []);

  const goNext = useCallback(() => {
    setActiveImageIndex((prev) => {
      if (prev === null) {
        return prev;
      }
      const len = flattenedImages.length;
      if (len <= 1) {
        return prev;
      }
      return (prev + 1) % len;
    });
  }, [flattenedImages.length]);

  const goPrev = useCallback(() => {
    setActiveImageIndex((prev) => {
      if (prev === null) {
        return prev;
      }
      const len = flattenedImages.length;
      if (len <= 1) {
        return prev;
      }
      return (prev - 1 + len) % len;
    });
  }, [flattenedImages.length]);

  const isSlideshowOpen = Boolean(currentEntry);

  useEffect(() => {
    if (!isSlideshowOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [goNext, goPrev, isSlideshowOpen]);

  let runningImageIndex = -1;

  return (
    <section className="border-b border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-950/40">
      <div className="px-3.5 pt-3 pb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Screenshots
        </h2>
        <span className="text-xs text-neutral-600 dark:text-neutral-400">
          {sortedScreenshotSets.length}{" "}
          {sortedScreenshotSets.length === 1 ? "capture" : "captures"}
        </span>
      </div>
      <div className="px-3.5 pb-4 space-y-4">
        {currentEntry ? (
          <Dialog.Root open={isSlideshowOpen} onOpenChange={(open) => !open && closeSlideshow()}>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 bg-neutral-950/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in data-[state=closed]:fade-out" />
              <Dialog.Content className="fixed inset-0 flex items-center justify-center p-6 focus:outline-none">
                <div className="relative flex w-full max-w-5xl flex-col gap-4 rounded-2xl border border-neutral-200 bg-white/95 p-4 shadow-2xl backdrop-blur-md focus:outline-none dark:border-neutral-800 dark:bg-neutral-950/90 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <Dialog.Title className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                        {currentEntry.image.fileName ?? "Screenshot"}
                      </Dialog.Title>
                      <Dialog.Description className="text-xs text-neutral-600 dark:text-neutral-400">
                        Image {currentEntry.indexInSet + 1} of {currentEntry.set.images.length} in this capture
                        {activeImageIndex !== null
                          ? ` • ${activeImageIndex + 1} of ${flattenedImages.length} overall`
                          : null}
                      </Dialog.Description>
                    </div>
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        onClick={closeSlideshow}
                        className="rounded-full border border-transparent bg-neutral-100/70 p-2 text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 dark:bg-neutral-800/60 dark:text-neutral-300 dark:hover:bg-neutral-700"
                        aria-label="Close slideshow"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </Dialog.Close>
                  </div>
                  <div className="flex flex-1 items-center justify-center gap-4">
                    {flattenedImages.length > 1 ? (
                      <button
                        type="button"
                        onClick={goPrev}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-300 bg-neutral-50 text-neutral-700 shadow transition hover:border-neutral-400 hover:bg-neutral-200 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800"
                        aria-label="Previous screenshot"
                      >
                        <ChevronLeft className="h-5 w-5" />
                      </button>
                    ) : null}
                    <div className="relative flex max-h-[70vh] flex-1 items-center justify-center border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
                      <img
                        src={currentEntry.image.url ?? undefined}
                        alt={currentEntry.image.fileName ?? "Screenshot"}
                        className="max-h-[calc(70vh-2rem)] max-w-full object-contain"
                      />
                    </div>
                    {flattenedImages.length > 1 ? (
                      <button
                        type="button"
                        onClick={goNext}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-300 bg-neutral-50 text-neutral-700 shadow transition hover:border-neutral-400 hover:bg-neutral-200 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800"
                        aria-label="Next screenshot"
                      >
                        <ChevronRight className="h-5 w-5" />
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                    <span>
                      Captured {formatDistanceToNow(new Date(currentEntry.set.capturedAt), { addSuffix: true })}
                    </span>
                    {currentEntry.set.commitSha ? (
                      <>
                        <span className="text-neutral-300 dark:text-neutral-600">•</span>
                        <span className="font-mono uppercase text-neutral-500 dark:text-neutral-400">
                          {currentEntry.set.commitSha.slice(0, 12)}
                        </span>
                      </>
                    ) : null}
                    <span className="text-neutral-300 dark:text-neutral-600">•</span>
                    <span>{STATUS_LABELS[currentEntry.set.status]}</span>
                  </div>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        ) : null}
        {sortedScreenshotSets.map((set) => {
          const capturedAtDate = new Date(set.capturedAt);
          const relativeCapturedAt = formatDistanceToNow(capturedAtDate, {
            addSuffix: true,
          });
          const shortCommit = set.commitSha?.slice(0, 12);
          const isHighlighted = effectiveHighlight === set._id;

          return (
            <article
              key={set._id}
              className={cn(
                "rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950/70 p-3 transition-shadow",
                isHighlighted &&
                  "border-emerald-400/70 dark:border-emerald-400/60 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "px-2 py-0.5 text-xs font-medium rounded-full",
                    STATUS_STYLES[set.status]
                  )}
                >
                  {STATUS_LABELS[set.status]}
                </span>
                {isHighlighted && (
                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100/80 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">
                    Latest
                  </span>
                )}
                <span
                  className="text-xs text-neutral-600 dark:text-neutral-400"
                  title={capturedAtDate.toLocaleString()}
                >
                  {relativeCapturedAt}
                </span>
                {shortCommit && (
                  <span className="text-xs font-mono text-neutral-600 dark:text-neutral-400">
                    {shortCommit.toLowerCase()}
                  </span>
                )}
                {set.images.length > 0 && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-500">
                    {set.images.length}{" "}
                    {set.images.length === 1 ? "image" : "images"}
                  </span>
                )}
              </div>
              {set.error && (
                <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
                  {set.error}
                </p>
              )}
                  {set.images.length > 0 ? (
                <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
                  {set.images.map((image) => {
                    const key = `${image.storageId}-${image.fileName ?? "unnamed"}`;
                    const displayName = image.fileName ?? "Screenshot";
                    if (!image.url) {
                      return (
                        <div
                          key={key}
                          className="flex h-48 min-w-[200px] items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-neutral-100 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
                        >
                          URL expired
                        </div>
                      );
                    }
                    runningImageIndex += 1;
                    const flatIndex = runningImageIndex;

                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setActiveImageIndex(flatIndex)}
                        className={cn(
                          "group relative flex w-[220px] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-left transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900/70 dark:hover:border-neutral-500",
                          activeImageIndex !== null &&
                            flatIndex === activeImageIndex &&
                            "border-emerald-400/70 shadow-[0_0_0_1px_rgba(16,185,129,0.25)] dark:border-emerald-400/60",
                        )}
                        aria-label={`Open ${displayName} in slideshow`}
                      >
                        <img
                          src={image.url}
                          alt={displayName}
                          className="h-48 w-[220px] object-contain bg-neutral-100 dark:bg-neutral-950"
                          loading="lazy"
                        />
                        <div className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/80 text-neutral-600 opacity-0 shadow-sm transition group-hover:opacity-100 dark:bg-neutral-950/80 dark:text-neutral-300">
                          <Maximize2 className="h-3.5 w-3.5" />
                        </div>
                        <div className="border-t border-neutral-200 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300 truncate">
                          {displayName}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {set.status === "failed"
                    ? "Screenshot capture failed before any images were saved."
                    : "No screenshots were captured for this attempt."}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
