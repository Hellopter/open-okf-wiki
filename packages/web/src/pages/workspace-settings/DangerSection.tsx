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
        <section
          className="flex flex-col gap-3 rounded-md border border-destructive/30 p-4"
          data-testid="settings-danger-zone"
        >
          <h2 className="text-base font-semibold text-destructive">{t.settings.dangerTitle}</h2>
          <p className="muted small">{t.settings.dangerDescription}</p>
          <div className="form-actions">
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
        </section>
      </CardContent>
    </Card>
  );
}
