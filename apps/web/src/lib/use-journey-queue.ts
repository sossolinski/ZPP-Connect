import type { SetStateAction } from "react";
import { useSearchParams } from "react-router-dom";
import { boundedQueueNumber } from "./journey-navigation";

type QueuePatch = Record<string, string | null>;

/** Apply related queue changes in one navigation; router setters do not queue updates. */
export function useQueuePatch() {
  const [, setParams] = useSearchParams();
  return (patch: QueuePatch) => setParams(current => {
    const result = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || !value) result.delete(key);
      else result.set(key, value.slice(0, 200));
    }
    return result;
  }, { replace: true });
}

export function useQueueText(key: string, fallback = "") {
  const [params] = useSearchParams();
  const patch = useQueuePatch();
  const value = params.get(key)?.slice(0, 200) ?? fallback;
  const setValue = (next: SetStateAction<string>, related: QueuePatch = {}) => {
    const text = typeof next === "function" ? next(value) : next;
    patch({ ...related, [key]: text === fallback ? null : text });
  };
  return [value, setValue] as const;
}

export function useQueueNumber(key: string, fallback: number, max: number) {
  const [params] = useSearchParams();
  const patch = useQueuePatch();
  const value = boundedQueueNumber(params.get(key), fallback, max);
  const setValue = (next: SetStateAction<number>, related: QueuePatch = {}) => {
    const number = typeof next === "function" ? next(value) : next;
    patch({ ...related, [key]: number === fallback ? null : String(Math.max(0, Math.min(max, number))) });
  };
  return [value, setValue] as const;
}
