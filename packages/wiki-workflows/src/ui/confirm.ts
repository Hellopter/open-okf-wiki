import type { WikiRunAgentView, WikiRunView } from "../workflow-types.js";
import { phaseRows } from "./stages.js";
import { uiStrings, type WikiUiLanguage } from "./strings.js";

export interface ConfirmPrompt {
  title: string;
  message: string;
}

export function cancelConfirm(language?: WikiUiLanguage): ConfirmPrompt {
  const s = uiStrings(language);
  return { title: s.cancelTitle, message: s.cancelMessage };
}

export function stopConfirm(language?: WikiUiLanguage): ConfirmPrompt {
  const s = uiStrings(language);
  return { title: s.stopTitle, message: s.stopMessage };
}

export function deleteConfirm(language?: WikiUiLanguage): ConfirmPrompt {
  const s = uiStrings(language);
  return { title: s.deleteTitle, message: s.deleteMessage };
}

export function retryAgentConfirm(run: WikiRunView, nodeId: string, language?: WikiUiLanguage): ConfirmPrompt | undefined {
  const s = uiStrings(language);
  const target = agentById(run, nodeId);
  if (!target || !run.allowedActions.retry) return undefined;
  return {
    title: s.retryAgentTitle(target.label),
    message: [
      s.retryRerun(target.label),
      s.retryGit,
      target.kind === "write" ? s.retryWritesWiki : s.retryNoWikiWrite,
    ].join("\n"),
  };
}

export function retryPhaseConfirm(run: WikiRunView, phaseId: string, language?: WikiUiLanguage): ConfirmPrompt | undefined {
  const s = uiStrings(language);
  const phase = phaseRows(run).find((item) => item.id === phaseId);
  if (!phase?.agents.length || !run.allowedActions.retry) return undefined;
  return {
    title: s.retryPhaseTitle(phase.title),
    message: [
      s.retryRerun(phase.agents.map((agent) => agent.label).join(", ")),
      s.retryGit,
      phase.agents.some((agent) => agent.kind === "write") ? s.retryWritesWiki : s.retryNoWikiWrite,
    ].join("\n"),
  };
}

function agentById(run: WikiRunView, nodeId: string): WikiRunAgentView | undefined {
  return run.phases.flatMap((phase) => phase.agents).find((agent) => agent.id === nodeId);
}
