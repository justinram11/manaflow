import { useCallback, useMemo } from "react";

import { focusWebview } from "@/lib/webview-actions";

interface UseWebviewActionsOptions {
  persistKey: string;
}

interface UseWebviewActionsResult {
  focus: () => Promise<boolean>;
}

export function useWebviewActions({
  persistKey,
}: UseWebviewActionsOptions): UseWebviewActionsResult {
  const focus = useCallback(() => {
    return focusWebview(persistKey);
  }, [persistKey]);

  return useMemo(() => {
    return { focus };
  }, [focus]);
}
