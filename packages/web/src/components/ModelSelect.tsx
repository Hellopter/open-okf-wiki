import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelProfilePublic } from "../api";
import { useI18n } from "../i18n";

type Props = {
  models: ModelProfilePublic[];
  value: string;
  onChange: (profileId: string) => void;
  defaultModelProfileId?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
  /** Override the default "Model" field label (e.g. role-specific labels). */
  label?: string;
  /** Hide the settings-link description under the select. */
  hideDescription?: boolean;
  /** Show empty option for optional selection. */
  allowEmpty?: boolean;
  emptyLabel?: string;
};

/** Sentinel for optional clear — Select item values cannot be empty string. */
const EMPTY_PROFILE_VALUE = "__none__";

function modelLabel(
  m: ModelProfilePublic,
  defaultModelProfileId: string | undefined,
  defaultSuffix: string,
): string {
  const suffix = defaultModelProfileId === m.id ? ` ${defaultSuffix}` : "";
  return `${m.name}${suffix} - ${m.modelId}`;
}

export function ModelSelect({
  models,
  value,
  onChange,
  defaultModelProfileId,
  id = "model-profile",
  required,
  disabled,
  "data-testid": testId = "model-profile-select",
  label,
  hideDescription,
  allowEmpty,
  emptyLabel,
}: Props) {
  const { t } = useI18n();
  const fieldLabel = label ?? t.modelSelect.label;
  const placeholder = emptyLabel ?? t.modelSelect.selectPlaceholder;

  const items = useMemo(() => {
    const mapped = models.map((m) => ({
      value: m.id,
      label: modelLabel(m, defaultModelProfileId, t.modelSelect.defaultSuffix),
    }));
    if (allowEmpty) {
      return [{ value: EMPTY_PROFILE_VALUE, label: placeholder }, ...mapped];
    }
    return mapped;
  }, [models, defaultModelProfileId, t.modelSelect.defaultSuffix, allowEmpty, placeholder]);

  if (models.length === 0) {
    return (
      <Field data-testid="model-select-empty">
        <FieldLabel htmlFor={id}>{fieldLabel}</FieldLabel>
        <FieldDescription>
          {t.modelSelect.emptyBefore}
          <Link to="/settings" className="text-primary no-underline hover:underline">
            {t.modelSelect.emptyLink}
          </Link>
          {t.modelSelect.emptyAfter}
        </FieldDescription>
      </Field>
    );
  }

  const selectValue = value
    ? value
    : allowEmpty
      ? EMPTY_PROFILE_VALUE
      : null;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{fieldLabel}</FieldLabel>
      <Select
        value={selectValue}
        onValueChange={(next) => {
          if (next === EMPTY_PROFILE_VALUE || (allowEmpty && next == null)) {
            onChange("");
          } else if (typeof next === "string") {
            onChange(next);
          }
        }}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          className="w-full max-w-md"
          data-testid={testId}
          aria-required={required || undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {allowEmpty ? (
              <SelectItem value={EMPTY_PROFILE_VALUE}>{placeholder}</SelectItem>
            ) : null}
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {modelLabel(m, defaultModelProfileId, t.modelSelect.defaultSuffix)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {hideDescription ? null : (
        <FieldDescription>
          {t.modelSelect.hintBefore}
          <Link to="/settings">{t.modelSelect.hintLink}</Link>
          {t.modelSelect.hintAfter}
        </FieldDescription>
      )}
    </Field>
  );
}
