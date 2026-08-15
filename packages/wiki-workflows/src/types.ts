export interface WikiValidationIssue {
  code: string;
  page?: string;
  message: string;
}

export interface WikiValidation {
  ok: boolean;
  issues: WikiValidationIssue[];
  pages: string[];
  obsoletePages: string[];
}

export interface WikiFinalization {
  pages: string[];
  obsoletePages: string[];
  removedPages: string[];
  rebuiltIndexes: string[];
}
