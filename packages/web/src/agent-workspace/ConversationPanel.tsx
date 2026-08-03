import { formatContextFill } from "@okf-wiki/contract/session";
import { SendIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComposerSessionChrome,
  ContextFillDetail,
  ContextFillMeter,
  ModelPicker,
  SlashCommandList,
} from "@/components/agent-ui";
import {
  filterSlashCommands,
  insertSlashCommand,
  mergeSlashCommands,
  type SlashCommandOption,
} from "@/components/agent-ui/context/slash-commands";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getProvider,
  listOperatorCommands,
  type ModelProfilePublic,
  type OperatorCommandInfo,
} from "../api";
import { formatMessage, type MessageTree } from "../i18n";
import { SessionTranscript } from "./SessionTranscript";
import type { SessionRunLink } from "./session-run-links";
import type { useSessionConversation } from "./useSessionConversation";

type SessionConversation = ReturnType<typeof useSessionConversation>;

type ConversationPanelProps = {
  conversation: SessionConversation;
  runs: SessionRunLink[];
  onOpenRun: (runId: string) => void;
  onPromptSubmitted: (text: string) => void;
  t: MessageTree;
  /** Load models/commands for this workspace's session composer. */
  workspaceId: string;
  /** Workspace default model profile id (fallback before set_model). */
  defaultProfileId?: string | null;
  /** Optional preloaded catalog (skips fetch when provided). */
  models?: ModelProfilePublic[];
  /** Optional preloaded slash commands (skips fetch when provided). */
  slashCommands?: OperatorCommandInfo[];
};

export function ConversationPanel({
  conversation,
  runs,
  onOpenRun,
  onPromptSubmitted,
  t,
  workspaceId,
  defaultProfileId,
  models: modelsProp,
  slashCommands: slashCommandsProp,
}: ConversationPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [models, setModels] = useState<ModelProfilePublic[]>(modelsProp ?? []);
  const [catalogDefaultId, setCatalogDefaultId] = useState<string | undefined>();
  const [slashCatalog, setSlashCatalog] = useState<SlashCommandOption[]>(() =>
    mergeSlashCommands(slashCommandsProp ?? []),
  );
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  useEffect(() => {
    if (modelsProp) {
      setModels(modelsProp);
      return;
    }
    let cancelled = false;
    void getProvider()
      .then((data) => {
        if (cancelled) return;
        setModels(data.provider.models);
        setCatalogDefaultId(data.provider.defaultModelProfileId);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [modelsProp, workspaceId]);

  useEffect(() => {
    if (slashCommandsProp) {
      setSlashCatalog(mergeSlashCommands(slashCommandsProp));
      return;
    }
    let cancelled = false;
    void listOperatorCommands()
      .then((data) => {
        if (cancelled) return;
        setSlashCatalog(mergeSlashCommands(data.commands));
      })
      .catch(() => {
        if (!cancelled) setSlashCatalog(mergeSlashCommands([]));
      });
    return () => {
      cancelled = true;
    };
  }, [slashCommandsProp]);

  const slashMatches = useMemo(() => {
    if (slashDismissed) return null;
    return filterSlashCommands(slashCatalog, prompt);
  }, [prompt, slashCatalog, slashDismissed]);

  useEffect(() => {
    setSlashActiveIndex(0);
    setSlashDismissed(false);
  }, [prompt]);

  const submitPrompt = async () => {
    const submitted = prompt.trim();
    if (!submitted || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      if (!(await conversation.send(submitted))) return;
      setPrompt("");
      onPromptSubmitted(submitted);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const pickSlashCommand = (command: SlashCommandOption) => {
    setPrompt(insertSlashCommand(command.name));
  };

  const isBusy = conversation.isBusy;
  const hasPrompt = Boolean(prompt.trim());
  /** When the agent is busy and the composer is empty, promote Stop as the primary action. */
  const emphasizeStop = isBusy && !hasPrompt;
  const profileId = conversation.currentModelProfileId ?? defaultProfileId ?? "";
  const fillView = formatContextFill(conversation.sessionUsage);
  const showMeter = Boolean(fillView);

  const contextLabels = {
    window: t.workbench.context.window,
    target: t.workbench.context.target,
    tokens: t.workbench.context.tokens,
    phase: t.workbench.context.phase,
    phases: t.workbench.context.phases,
    compactHint: t.workbench.context.compactHint,
    insertCompact: t.workbench.context.insertCompact,
  };

  const insertCompact = () => {
    setPrompt(insertSlashCommand("compact"));
  };

  return (
    <>
      <SessionTranscript messages={conversation.messages} runs={runs} onOpenRun={onOpenRun} />
      <form
        className="shrink-0 border-t border-border bg-background px-4 py-3 md:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (slashMatches && slashMatches.length > 0) {
            const selected = slashMatches[slashActiveIndex] ?? slashMatches[0];
            if (selected) {
              pickSlashCommand(selected);
              return;
            }
          }
          void submitPrompt();
        }}
      >
        <div className="relative rounded-xl border border-border bg-muted/20 p-2 shadow-sm">
          {slashMatches && slashMatches.length > 0 ? (
            <SlashCommandList
              commands={slashMatches}
              activeIndex={Math.min(slashActiveIndex, slashMatches.length - 1)}
              onActiveIndexChange={setSlashActiveIndex}
              onSelect={pickSlashCommand}
              listLabel={t.workbench.slash.listLabel}
            />
          ) : null}
          <InputGroup className="border-0 bg-transparent shadow-none">
            <InputGroupTextarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (slashMatches && slashMatches.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashActiveIndex((index) => (index + 1) % slashMatches.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashActiveIndex(
                      (index) => (index - 1 + slashMatches.length) % slashMatches.length,
                    );
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                  if (event.key === "Tab") {
                    event.preventDefault();
                    const selected = slashMatches[slashActiveIndex] ?? slashMatches[0];
                    if (selected) pickSlashCommand(selected);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={isBusy ? t.workbench.promptBusy : t.workbench.promptIdle}
              rows={2}
              required={true}
              disabled={isSubmitting}
              aria-busy={isBusy || isSubmitting || undefined}
              aria-keyshortcuts="Enter"
              aria-autocomplete={slashMatches ? "list" : undefined}
              title={t.workbench.send}
            />
            <InputGroupAddon align="block-end" className="justify-between gap-1">
              <ComposerSessionChrome
                leading={
                  <>
                    <ModelPicker
                      models={models}
                      value={profileId}
                      onChange={(next) => {
                        void conversation.setModel(next);
                      }}
                      defaultModelProfileId={defaultProfileId ?? catalogDefaultId}
                      disabled={isBusy || isSubmitting}
                      title={isBusy ? t.workbench.modelPicker.busyTitle : undefined}
                      ariaLabel={t.workbench.modelPicker.ariaLabel}
                      menuLabel={t.workbench.modelPicker.menuLabel}
                      defaultSuffix={t.modelSelect.defaultSuffix}
                      emptyLabel={t.workbench.modelPicker.empty}
                      emptySettingsTitle={t.workbench.modelPicker.emptySettingsTitle}
                      maxContextLabel={(n) =>
                        formatMessage(t.workbench.modelPicker.maxContext, { n })
                      }
                    />
                    {showMeter ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className="inline-flex items-center rounded-md px-1 py-0.5 hover:bg-muted/60"
                                aria-label={t.workbench.context.meterAria}
                              />
                            }
                          >
                            <ContextFillMeter
                              usage={conversation.sessionUsage}
                              phase={conversation.contextPhase}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start" className="max-w-xs">
                            <ContextFillDetail
                              usage={conversation.sessionUsage}
                              phase={conversation.contextPhase}
                              labels={contextLabels}
                              onInsertCompact={insertCompact}
                            />
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : null}
                  </>
                }
                trailing={
                  <>
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant={emphasizeStop ? "outline" : "default"}
                      disabled={isSubmitting || !hasPrompt}
                      aria-label={t.workbench.send}
                      title={t.workbench.send}
                    >
                      {isSubmitting ? <Spinner /> : <SendIcon />}
                    </InputGroupButton>
                    {isBusy ? (
                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        variant={emphasizeStop ? "default" : "outline"}
                        onClick={() => void conversation.abort()}
                        aria-label={t.workbench.stop}
                        title={t.workbench.stop}
                      >
                        <SquareIcon />
                      </InputGroupButton>
                    ) : null}
                  </>
                }
              />
            </InputGroupAddon>
          </InputGroup>
        </div>
      </form>
    </>
  );
}
