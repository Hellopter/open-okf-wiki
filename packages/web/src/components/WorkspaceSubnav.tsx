import { BookOpenIcon, BotIcon, FolderGit2Icon, MenuIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";
import { agentWorkspaceHref, workspaceHref } from "../lib/workspace-path";

type Props = {
  workspaceId: string;
  /** Slim icon rail for immersive agent chrome. */
  compact?: boolean;
};

type Tab =
  | {
      kind: "agent";
      label: string;
      testId: string;
      icon: typeof BotIcon;
    }
  | {
      kind: "path";
      suffix: "/sources" | "/wiki" | "/settings";
      label: string;
      end: boolean;
      testId: string;
      icon: typeof BotIcon;
    };

function useWorkspaceTabs(): Tab[] {
  const { t } = useI18n();
  return [
    {
      kind: "agent",
      label: t.subnav.agent,
      testId: "workspace-subnav-agent",
      icon: BotIcon,
    },
    {
      kind: "path",
      suffix: "/sources",
      label: t.subnav.sources,
      end: false,
      testId: "workspace-subnav-sources",
      icon: FolderGit2Icon,
    },
    {
      kind: "path",
      suffix: "/wiki",
      label: t.subnav.wiki,
      end: false,
      testId: "workspace-subnav-wiki",
      icon: BookOpenIcon,
    },
    {
      kind: "path",
      suffix: "/settings",
      label: t.subnav.settings,
      end: false,
      testId: "workspace-subnav-settings",
      icon: SettingsIcon,
    },
  ];
}

function TabLink({
  tab,
  workspaceId,
  rootPath,
  onAgent,
  compact,
  onNavigate,
}: {
  tab: Tab;
  workspaceId: string;
  rootPath: string | null;
  onAgent: boolean;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = tab.icon;
  if (tab.kind === "agent") {
    return (
      <NavLink
        to={agentWorkspaceHref(workspaceId, rootPath)}
        title={tab.label}
        onClick={onNavigate}
        className={cn(
          compact
            ? "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
            : "subnav-link",
          compact && onAgent && "bg-muted text-foreground",
          !compact && onAgent && "active",
        )}
        data-testid={tab.testId}
        end
      >
        {compact ? (
          <>
            <Icon className="size-3.5" />
            <span className="sr-only">{tab.label}</span>
          </>
        ) : (
          tab.label
        )}
      </NavLink>
    );
  }

  return (
    <NavLink
      to={workspaceHref(workspaceId, tab.suffix, rootPath)}
      end={tab.end}
      title={tab.label}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          compact
            ? "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
            : "subnav-link",
          compact && isActive && !onAgent && "bg-muted text-foreground",
          !compact && isActive && !onAgent && "active",
        )
      }
      data-testid={tab.testId}
    >
      {compact ? (
        <>
          <Icon className="size-3.5" />
          <span className="sr-only">{tab.label}</span>
        </>
      ) : (
        tab.label
      )}
    </NavLink>
  );
}

export function WorkspaceSubnav({ workspaceId, compact = false }: Props) {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");
  const onAgent = location.pathname.startsWith("/w/");
  const tabs = useWorkspaceTabs();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (compact) {
    return (
      <nav
        className="flex shrink-0 items-center gap-0.5"
        aria-label="Workspace section icons"
        data-testid="workspace-subnav"
      >
        {tabs.map((tab) => (
          <TabLink
            key={tab.testId}
            tab={tab}
            workspaceId={workspaceId}
            rootPath={rootPath}
            onAgent={onAgent}
            compact
          />
        ))}
      </nav>
    );
  }

  return (
    <>
      {/* Desktop / tablet: always-visible section links */}
      <nav
        className="subnav hidden sm:flex"
        aria-label="Workspace sections"
        data-testid="workspace-subnav"
      >
        {tabs.map((tab) => (
          <TabLink
            key={tab.testId}
            tab={tab}
            workspaceId={workspaceId}
            rootPath={rootPath}
            onAgent={onAgent}
          />
        ))}
      </nav>

      {/* Mobile: trigger + controlled sheet panel */}
      <div className="sm:hidden" data-testid="workspace-subnav-mobile">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t.subnav.openMenu}
                data-testid="workspace-subnav-menu"
              />
            }
          >
            <MenuIcon data-icon="inline-start" />
            {t.subnav.menuTitle}
          </SheetTrigger>
          <SheetContent side="bottom" className="gap-0 p-0">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle>{t.subnav.menuTitle}</SheetTitle>
            </SheetHeader>
            <nav
              className="flex flex-col gap-1 p-3"
              aria-label="Workspace sections menu"
              data-testid="workspace-subnav"
            >
              {tabs.map((tab) => (
                <TabLink
                  key={tab.testId}
                  tab={tab}
                  workspaceId={workspaceId}
                  rootPath={rootPath}
                  onAgent={onAgent}
                  onNavigate={() => setMobileOpen(false)}
                />
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
