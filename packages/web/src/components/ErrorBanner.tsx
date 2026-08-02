import { CircleAlert } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApiError } from "../api";
import { useI18n } from "../i18n";
import { formatError } from "../lib/notify";

export { formatError } from "../lib/notify";

type Props = {
  error: unknown;
  onDismiss?: () => void;
};

/**
 * Persistent page/region load (or stream) failure banner.
 * Do not use for one-shot action results — those go through notifyError (toast).
 */
export function ErrorBanner({ error, onDismiss }: Props) {
  const { t } = useI18n();
  if (!error) {
    return null;
  }

  const message = formatError(error, t.errorBanner.unknown);
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as ApiError).status
      : undefined;

  return (
    <Alert variant="destructive" data-testid="error-banner" className="m-3 shrink-0 md:mx-4">
      <CircleAlert />
      <AlertTitle>
        {t.errorBanner.title}
        {status ? ` (${status})` : ""}
      </AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words">{message}</AlertDescription>
      {onDismiss ? (
        <AlertAction>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {t.errorBanner.dismiss}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
