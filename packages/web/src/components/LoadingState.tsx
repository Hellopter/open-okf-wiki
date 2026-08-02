import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "../i18n";

export type LoadingStateProps = {
  label?: string;
  /** skeleton: multi-line placeholder (default). activity: compact spinner + label. */
  variant?: "skeleton" | "activity";
};

export function LoadingState({ label, variant = "skeleton" }: LoadingStateProps) {
  const { t } = useI18n();
  const text = label ?? t.loading.default;

  if (variant === "activity") {
    return (
      <div
        className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-label={text}
      >
        <Spinner className="size-4 shrink-0" aria-hidden />
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-4" role="status" aria-live="polite" aria-label={text}>
      <Skeleton className="h-4 w-40 max-w-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-4 w-52 max-w-full" />
      <span className="sr-only">{text}</span>
    </div>
  );
}
