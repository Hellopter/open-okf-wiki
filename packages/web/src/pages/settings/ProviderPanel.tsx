import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ModelProfilePublic, ProviderEntryPublic, ProviderPublic } from "../../api";
import { formatMessage, useI18n } from "../../i18n";

export type ProviderPanelProps = {
  provider: ProviderPublic | null;
  models: ModelProfilePublic[];
  providers: ProviderEntryPublic[];
  catalogEmpty: boolean;
  deletingId: string | null;
  onAddModel: (providerId: string) => void;
  onEditProvider: (entry: ProviderEntryPublic) => void;
  onDeleteProvider: (entry: ProviderEntryPublic) => void;
  onEditModel: (model: ModelProfilePublic) => void;
  onDeleteModel: (model: ModelProfilePublic) => void;
  onSetDefault: (model: ModelProfilePublic) => void;
};

export function ProviderPanel({
  provider,
  models,
  providers,
  catalogEmpty,
  deletingId,
  onAddModel,
  onEditProvider,
  onDeleteProvider,
  onEditModel,
  onDeleteModel,
  onSetDefault,
}: ProviderPanelProps) {
  const { t } = useI18n();

  return (
    <Card data-testid="provider-panel">
      <CardHeader className="row-between items-center">
        <div className="flex flex-col gap-1">
          <CardTitle>{t.globalSettings.modelsTitle}</CardTitle>
          <p className="muted small max-w-2xl">{t.globalSettings.providersHint}</p>
        </div>
        <span className="muted small shrink-0">
          {formatMessage(t.globalSettings.modelsCount, { n: models.length })}
          {provider?.defaultModelProfileId
            ? ` · ${t.globalSettings.defaultSet}`
            : models.length > 0
              ? ` · ${t.globalSettings.noDefault}`
              : ""}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {catalogEmpty ? (
          <Empty className="border-0 p-6" data-testid="models-empty">
            <EmptyHeader>
              <EmptyTitle className="text-base">{t.globalSettings.modelsEmpty}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4" data-testid="providers-list">
            {providers.map((entry) => (
              <Card
                key={entry.id}
                className="border-border/80"
                data-testid="provider-card"
                data-provider-id={entry.id}
              >
                <CardHeader className="row-between items-start py-3">
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <CardTitle className="text-base">{entry.name}</CardTitle>
                    <p className="mono small muted truncate">{entry.baseUrl || "—"}</p>
                    <p className="small muted">
                      {entry.apiShape}
                      {" · "}
                      {entry.apiKeySet ? (entry.apiKeyMasked ?? t.globalSettings.keySet) : "—"}
                      {entry.headers?.["User-Agent"]
                        ? ` · UA=${entry.headers["User-Agent"]}`
                        : ""}
                      {entry.supportsDeveloperRole
                        ? ` · ${t.globalSettings.developerRoleOn}`
                        : ""}
                    </p>
                  </div>
                  <div className="row-actions shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onAddModel(entry.id)}
                      data-testid="provider-add-model"
                    >
                      {t.globalSettings.addModelUnderProvider}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onEditProvider(entry)}
                      data-testid="provider-edit"
                    >
                      {t.globalSettings.edit}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => onDeleteProvider(entry)}
                      data-testid="provider-delete"
                    >
                      {t.globalSettings.delete}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {entry.models.length === 0 ? (
                    <p className="muted small py-2" data-testid="provider-models-empty">
                      {t.globalSettings.providerModelsEmpty}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t.globalSettings.colName}</TableHead>
                          <TableHead>{t.globalSettings.colModelId}</TableHead>
                          <TableHead>{t.globalSettings.colMaxContext}</TableHead>
                          <TableHead className="text-right">{t.globalSettings.colActions}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {entry.models.map((m) => {
                          const model = models.find((x) => x.id === m.id);
                          if (!model) return null;
                          const isDefault = provider?.defaultModelProfileId === model.id;
                          return (
                            <TableRow
                              key={model.id}
                              data-testid="model-row"
                              data-model-id={model.id}
                            >
                              <TableCell>
                                <span className="font-medium">{model.name}</span>
                                {isDefault ? (
                                  <Badge variant="secondary" className="ml-2">
                                    {t.globalSettings.defaultBadge}
                                  </Badge>
                                ) : null}
                              </TableCell>
                              <TableCell className="mono small">{model.modelId}</TableCell>
                              <TableCell className="mono small">
                                {model.maxContextTokens !== undefined
                                  ? model.maxContextTokens.toLocaleString()
                                  : "—"}
                              </TableCell>
                              <TableCell className="actions-cell">
                                <div className="row-actions justify-end">
                                  {!isDefault ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => void onSetDefault(model)}
                                      data-testid="model-set-default"
                                    >
                                      {t.globalSettings.setDefault}
                                    </Button>
                                  ) : null}
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => onEditModel(model)}
                                    data-testid="model-edit"
                                  >
                                    {t.globalSettings.edit}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    disabled={deletingId === model.id}
                                    onClick={() => onDeleteModel(model)}
                                    data-testid="model-delete"
                                  >
                                    {deletingId === model.id ? (
                                      <Spinner data-icon="inline-start" />
                                    ) : null}
                                    {deletingId === model.id
                                      ? t.globalSettings.deleting
                                      : t.globalSettings.delete}
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            ))}
            {/* Fallback flat table if providers empty but models exist */}
            {providers.length === 0 && models.length > 0 ? (
              <Table data-testid="models-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.globalSettings.colName}</TableHead>
                    <TableHead>{t.globalSettings.colModelId}</TableHead>
                    <TableHead>{t.globalSettings.colBaseUrl}</TableHead>
                    <TableHead className="text-right">{t.globalSettings.colActions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((model) => (
                    <TableRow key={model.id} data-testid="model-row">
                      <TableCell>{model.name}</TableCell>
                      <TableCell className="mono small">{model.modelId}</TableCell>
                      <TableCell className="mono small">{model.baseUrl}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onEditModel(model)}
                        >
                          {t.globalSettings.edit}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </div>
        )}

        {provider ? (
          <p className="muted small">
            {formatMessage(t.globalSettings.envFallback, {
              base: provider.envFallback.openaiBaseUrlSet
                ? t.globalSettings.envSet
                : t.globalSettings.envUnset,
              key: provider.envFallback.openaiApiKeySet
                ? t.globalSettings.envSet
                : t.globalSettings.envUnset,
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
