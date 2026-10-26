import { useCallback, useEffect, useRef, useState } from "react";
import { workbenchApi, type WorkbenchApi } from "./api";
import type { WorkbenchData } from "./types";

export function useWorkbench(enabled: boolean, api: WorkbenchApi = workbenchApi) {
  const [data, setData] = useState<WorkbenchData>({ tasks: [] });
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    try {
      const next = await api.load();
      if (alive.current) {
        setData(next && Array.isArray(next.tasks) ? next : { tasks: [] });
        setError(undefined);
      }
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally { busy.current = false; }
  }, [api, enabled]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => { alive.current = false; window.clearInterval(interval); };
  }, [enabled, refresh]);

  return { data, error, refresh };
}
