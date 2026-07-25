import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useI18n } from "../i18n";
import { useTheme } from "../theme/use-theme";

/**
 * App-level Cmd/Ctrl+K command palette: navigation + theme toggle.
 */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { t } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Keep key + modifier checks in one condition for hotkey-safety scanners.
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <>
      {/* Discoverable + e2e-stable entry; hotkey remains primary for operators. */}
      <button
        type="button"
        className="sr-only"
        data-testid="command-menu-trigger"
        aria-label={t.commandMenu.title}
        onClick={() => setOpen(true)}
      >
        {t.commandMenu.title}
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t.commandMenu.title}
        description={t.commandMenu.description}
      >
        <Command
          // cmdk root — required for list filtering / item selection.
          shouldFilter
        >
          <CommandInput placeholder={t.commandMenu.placeholder} />
          <CommandList>
            <CommandEmpty>{t.commandMenu.empty}</CommandEmpty>
            <CommandGroup heading={t.commandMenu.navigate}>
              <CommandItem value="workspaces" onSelect={() => go("/workspaces")}>
                {t.nav.workspaces}
              </CommandItem>
              <CommandItem value="settings" onSelect={() => go("/settings")}>
                {t.nav.settings}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t.commandMenu.appearance}>
              <CommandItem
                value="toggle-theme"
                onSelect={() => {
                  toggleTheme();
                  setOpen(false);
                }}
              >
                {resolvedTheme === "dark" ? t.commandMenu.themeLight : t.commandMenu.themeDark}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
