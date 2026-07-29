import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { getApiBase, type DoctorResponse, type HealthResponse } from "../../api";
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
        <CardContent className="flex flex-col gap-4">
          <dl className="kv">
            <div>
              <dt>{t.globalSettings.apiBase}</dt>
              <dd className="mono">{getApiBase() || t.globalSettings.apiBaseSameOrigin}</dd>
            </div>
            <div>
              <dt>{t.globalSettings.health}</dt>
              <dd>
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
                  <span className="muted">{t.globalSettings.healthNotChecked}</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="form-actions">
            <Button type="button" onClick={() => void onHealthCheck()} disabled={checkingHealth}>
              {checkingHealth ? <Spinner data-icon="inline-start" /> : null}
              {checkingHealth ? t.globalSettings.checking : t.globalSettings.runHealthCheck}
            </Button>
          </div>
        </CardContent>
      </Card>

      {doctor ? (
        <Card data-testid="doctor-panel">
          <CardHeader>
            <CardTitle>{t.globalSettings.doctorTitle}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="kv kv-grid">
              <div>
                <dt>{t.globalSettings.status}</dt>
                <dd>
                  <Badge
                    variant={doctor.ok ? "secondary" : "destructive"}
                    data-testid="doctor-status"
                  >
                    {doctor.ok ? t.globalSettings.statusOk : t.globalSettings.statusNotOk}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>{t.globalSettings.node}</dt>
                <dd className="mono">{doctor.node}</dd>
              </div>
              <div>
                <dt>{t.globalSettings.platform}</dt>
                <dd className="mono">
                  {doctor.platform}/{doctor.arch}
                </dd>
              </div>
              <div>
                <dt>{t.globalSettings.git}</dt>
                <dd>
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
              <div>
                <dt>{t.globalSettings.doctorModels}</dt>
                <dd>
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
                    <span className="muted">—</span>
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
