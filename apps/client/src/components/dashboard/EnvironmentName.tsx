import { isFakeConvexId } from "@/lib/fakeConvexId";
import {
  getApiEnvironmentsByIdOptions,
} from "@cmux/www-openapi-client/react-query";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

interface EnvironmentNameProps {
  environmentId: string;
  teamSlugOrId: string;
}

export function EnvironmentName({
  environmentId,
  teamSlugOrId,
}: EnvironmentNameProps) {
  const isFake = isFakeConvexId(environmentId);
  const environmentQuery = useQuery({
    ...getApiEnvironmentsByIdOptions({ path: { id: environmentId }, query: { teamSlugOrId } }),
    enabled: !isFake,
  });
  const environment = environmentQuery.data;
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (environment) {
      // Trigger fade-in after mount
      setIsVisible(true);
    }
  }, [environment]);

  if (!environment) {
    return null;
  }

  return (
    <span
      className="text-[11px] text-neutral-400 dark:text-neutral-500 flex-shrink-0 ml-auto mr-0 transition-opacity duration-200"
      style={{ opacity: isVisible ? 1 : 0 }}
    >
      {environment.name}
    </span>
  );
}

