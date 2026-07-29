import type { ProviderApiShape } from "../../api";

export type EditorMode = "closed" | "create" | "edit";

/** Model editor: model-level fields only — connection lives on the provider. */
export type ModelFormState = {
  name: string;
  modelId: string;
  /** Empty string means unset; digits-only string when set. */
  maxContextTokens: string;
  /** Owning provider (provider-first flow). */
  providerId: string;
};

/** Provider editor: gateway connection (one provider hosts many models). */
export type ProviderFormState = {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiShape: ProviderApiShape;
  /** Provider-level User-Agent (default node for gateway WAF). */
  userAgent: string;
  /**
   * When true, allow OpenAI `developer` role (official OpenAI).
   * Default false — third-party gateways often reject it.
   */
  supportsDeveloperRole: boolean;
  clearApiKey: boolean;
};

export const emptyModelForm: ModelFormState = {
  name: "",
  modelId: "",
  maxContextTokens: "",
  providerId: "",
};

export const emptyProviderForm: ProviderFormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  apiShape: "completions",
  userAgent: "node",
  supportsDeveloperRole: false,
  clearApiKey: false,
};
