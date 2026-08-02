import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { type DoctorResponse, getApiBase, type HealthResponse } from "../../api";
import { formatMessage, useI18n } from "../../i18n";

export type DiagnosticsPanelProps = {
  health: HealthResponse | null;
  doctor: DoctorResponse | null;
  checkingHealth: boolean;
  onHealthCheck: () => void;
};

export function DiagnosticsPanel({
  health,
  doctor,
  checkingHealth,
  onHealthCheck,
}: DiagnosticsPanelProps) {
  const { t } = useI18n();

  return (
    <>
      <Card data-testid="health-panel">
        <CardHeader>
          <CardTitle>{t.globalSettings.healthTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="m-0 flex flex-col gap-4">
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">{t.globalSettings.apiBase}</dt>
              <dd className="m-0 break-words font-mono">
                {getApiBase() || t.globalSettings.apiBaseSameOrigin}
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">{t.globalSettings.health}</dt>
              <dd className="m-0 break-words">
                {health ? (
                  <Badge
                    variant={health.ok ? "secondary" : "destructive"}
                    data-testid="health-status"
                  >
                    {health.ok
                      ? formatMessage(t.globalSettings.healthOk, {
                          service: health.service,
                        })
                      : t.globalSettings.healthNotOk}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">{t.globalSettings.healthNotChecked}</span>
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
        <CardFooter>
          <Button type="button" onClick={() => void onHealthCheck()} disabled={checkingHealth}>
            {checkingHealth ? <Spinner data-icon="inline-start" /> : null}
            {checkingHealth ? t.globalSettings.checking : t.globalSettings.runHealthCheck}
          </Button>
        </CardFooter>
      </Card>

      {doctor ? (
        <Card data-testid="doctor-panel">
          <CardHeader>
            <CardTitle>{t.globalSettings.doctorTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">{t.globalSettings.status}</dt>
                <dd className="m-0 break-words">
                  <Badge
                    variant={doctor.ok ? "secondary" : "destructive"}
                    data-testid="doctor-status"
                  >
                    {doctor.ok ? t.globalSettings.statusOk : t.globalSettings.statusNotOk}
                  </Badge>
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">{t.globalSettings.node}</dt>
                <dd className="m-0 break-words font-mono">{doctor.node}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">{t.globalSettings.platform}</dt>
                <dd className="m-0 break-words font-mono">
                  {doctor.platform}/{doctor.arch}
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">{t.globalSettings.git}</dt>
                <dd className="m-0 break-words">
                  {doctor.git.available ? (
                    <Badge variant="secondary">
                      {t.globalSettings.gitAvailable}
                      {doctor.git.version ? ` · ${doctor.git.version}` : ""}
                    </Badge>
                  ) : (
                    <Badge variant="destructive">{t.globalSettings.gitUnavailable}</Badge>
                  )}
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs text-muted-foreground">{t.globalSettings.doctorModels}</dt>
                <dd className="m-0 break-words">
                  {doctor.provider ? (
                    <Badge
                      variant={doctor.provider.configured ? "secondary" : "outline"}
                      data-testid="doctor-provider-status"
                    >
                      {formatMessage(t.globalSettings.doctorModelsConfigured, {
                        n: doctor.provider.modelCount ?? 0,
                      })}
                      {doctor.provider.configured
                        ? ""
                        : ` · ${t.globalSettings.doctorNoCredentials}`}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
