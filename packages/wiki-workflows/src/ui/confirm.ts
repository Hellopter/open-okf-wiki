import type { WikiRunSnapshot } from "../workflow-types.js";
import { describeNodes, phaseRetryImpact, retryImpact } from "./impact.js";
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

export function deleteConfirm(language?: WikiUiLanguage): ConfirmPrompt {
  const s = uiStrings(language);
  return { title: s.deleteTitle, message: s.deleteMessage };
}

export function retryAgentConfirm(run: WikiRunSnapshot, nodeId: string, language?: WikiUiLanguage): ConfirmPrompt | undefined {
  const s = uiStrings(language);
  const impact = retryImpact(run, nodeId);
  const target = run.nodes.find((node) => node.id === nodeId);
  if (!impact || !target) return undefined;
  const preserved = describeNodes(run, impact.preservedUpstream) || "none";
  const rerun = describeNodes(run, [...impact.targetIds, ...impact.invalidatedDownstream]) || target.label;
  return {
    title: s.retryAgentTitle(target.label),
    message: [
      s.retryKeepUpstream(preserved),
      s.retryRerun(rerun),
      s.retryGit,
      impact.writesWiki ? s.retryWritesWiki : s.retryNoWikiWrite,
    ].join("\n"),
  };
}

export function retryPhaseConfirm(run: WikiRunSnapshot, phaseId: string, language?: WikiUiLanguage): ConfirmPrompt | undefined {
  const s = uiStrings(language);
  const impact = phaseRetryImpact(run, phaseId);
  const target = impact ? run.nodes.find((node) => node.id === impact.targetId) : undefined;
  if (!impact || !target) return undefined;
  const phase = phaseRows(run).find((item) => item.id === phaseId);
  const preserved = describeNodes(run, impact.preservedUpstream) || "none";
  const rerun = describeNodes(run, [...impact.targetIds, ...impact.invalidatedDownstream]) || target.label;
  return {
    title: s.retryPhaseTitle(phase?.title ?? target.label),
    message: [
      s.retryKeepUpstream(preserved),
      s.retryRerun(rerun),
      s.retryGit,
      impact.writesWiki ? s.retryWritesWiki : s.retryNoWikiWrite,
    ].join("\n"),
  };
}
