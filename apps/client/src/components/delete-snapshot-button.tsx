import { forwardRef, useState, type ComponentProps } from "react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/delete-button";
import { queryClient } from "@/query-client";
import { deleteApiSandboxesIncusSnapshotsBySnapshotId } from "@cmux/www-openapi-client";
import { cn } from "@/lib/utils";
import { Loader2, Trash2 } from "lucide-react";

type DeleteSnapshotButtonProps = Omit<
  ComponentProps<typeof DeleteButton>,
  "onClick" | "children"
> & {
  teamSlugOrId: string;
  environmentId: string;
  snapshotVersionId: string;
  snapshotsQueryKey?: readonly unknown[];
  confirmMessage?: string;
  onSuccess?: () => void;
};

export const DeleteSnapshotButton = forwardRef<
  HTMLButtonElement,
  DeleteSnapshotButtonProps
>(
  (
    {
      teamSlugOrId: _teamSlugOrId,
      environmentId: _environmentId,
      snapshotVersionId,
      snapshotsQueryKey,
      confirmMessage =
        "Are you sure you want to delete this snapshot version? This action cannot be undone.",
      onSuccess,
      className,
      disabled,
      ...buttonProps
    },
    ref,
  ) => {
    const [isPending, setIsPending] = useState(false);

    const handleDelete = async () => {
      if (!confirm(confirmMessage)) {
        return;
      }

      setIsPending(true);
      try {
        await deleteApiSandboxesIncusSnapshotsBySnapshotId({
          path: { snapshotId: snapshotVersionId },
        });
        toast.success("Snapshot version deleted");
        if (snapshotsQueryKey) {
          await queryClient.invalidateQueries({ queryKey: snapshotsQueryKey });
        }
        onSuccess?.();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to delete snapshot version";
        toast.error(message);
      } finally {
        setIsPending(false);
      }
    };

    return (
      <DeleteButton
        ref={ref}
        onClick={handleDelete}
        disabled={disabled || isPending}
        className={cn(
          "gap-1 px-3 py-1 text-xs",
          isPending && "cursor-wait",
          className,
        )}
        {...buttonProps}
      >
        {isPending ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Deleting…
          </>
        ) : (
          <>
            <Trash2 className="h-3 w-3" />
            Delete
          </>
        )}
      </DeleteButton>
    );
  },
);

DeleteSnapshotButton.displayName = "DeleteSnapshotButton";
