import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "../../i18n";

export type DangerSectionProps = {
  deleting: boolean;
  onRequestDelete: () => void;
};

export function DangerSection({ deleting, onRequestDelete }: DangerSectionProps) {
  const { t } = useI18n();

  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <Alert variant="destructive" data-testid="settings-danger-zone">
          <CircleAlert />
          <AlertTitle>{t.settings.dangerTitle}</AlertTitle>
          <AlertDescription>{t.settings.dangerDescription}</AlertDescription>
          <div className="form-actions col-start-2">
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={onRequestDelete}
              data-testid="settings-delete-workspace"
            >
              {deleting ? <Spinner data-icon="inline-start" /> : null}
              {deleting ? t.common.deleting : t.settings.deleteWorkspace}
            </Button>
          </div>
        </Alert>
      </CardContent>
    </Card>
  );
}
