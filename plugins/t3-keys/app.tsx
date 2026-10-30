import { definePluginApp } from "@get-bb/plugin-sdk/app";

// Shortcuts T3 Code has and bb lacks. Each is a palette command, so the key
// can be rebound in bb's keyboard settings. Diff (Cmd+D) is not here: bb's
// built-in git plugin already registers "Toggle diff" on Cmd+D.

// Pages of other plugins, reached through bb's router: push the URL and let
// it react to popstate, so the window does not reload.
const USAGE_PAGE = "/plugins/usage/usage";
const FILES_PAGE = "/plugins/files-editor/files";

/** Open a page, or leave it when already there (a toggle, like T3's Cmd+U):
 * going back through history returns to exactly where you were. Returns
 * whether the page is now open. */
function togglePage(path: string): boolean {
  if (window.location.pathname === path) {
    window.history.back();
    return false;
  }
  window.history.pushState(window.history.state, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  return true;
}

/** Focus an element once it appears; pages mount after navigation. */
function focusWhenReady(selector: string, timeoutMs = 3000): void {
  const started = performance.now();
  const attempt = () => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      element.focus();
      if (element instanceof HTMLInputElement) element.select();
      return;
    }
    if (performance.now() - started < timeoutMs) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** A short confirmation near the bottom of the window. */
function flash(text: string): void {
  const note = document.createElement("div");
  note.textContent = text;
  note.setAttribute("role", "status");
  Object.assign(note.style, {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    padding: "6px 12px",
    borderRadius: "8px",
    font: "500 12px/1.4 var(--font-sans, system-ui)",
    background: "var(--popover, #1f1f1f)",
    color: "var(--popover-foreground, #fafafa)",
    border: "1px solid var(--border, #333)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(note);
  window.setTimeout(() => note.remove(), 1400);
}

export default definePluginApp((app) => {
  app.commands.register({
    id: "copy-thread-reference",
    title: "Copy thread reference",
    defaultShortcut: { key: "c", mod: true, shift: true },
    isAvailable: (context) => context.threadId !== null,
    async run(context) {
      if (!context.threadId) return;
      const reference = `@thread:${context.threadId}`;
      await navigator.clipboard.writeText(reference);
      flash(`Copied ${reference}`);
    },
  });

  app.commands.register({
    id: "open-usage",
    title: "Toggle usage",
    defaultShortcut: { key: "u", mod: true },
    run() {
      togglePage(USAGE_PAGE);
    },
  });

  // bb-sidebar's "All projects" filter above the thread list. Its popover
  // focuses the "Filter projects" field on open, so the whole pick is typing.
  app.commands.register({
    id: "filter-sidebar-by-project",
    title: "Filter sidebar by project",
    defaultShortcut: { key: "/", mod: true },
    run() {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Project scope:"]');
      if (!trigger) {
        flash("Project filter not found: is the sidebar open (⌘B)?");
        return;
      }
      trigger.focus();
      trigger.click();
    },
  });

  // Inside that filter, Cmd+Backspace clears it: same as picking "All
  // projects", without typing. The query is cleared first (through React's
  // value setter, so the list re-renders), because a typed query can hide
  // the "All projects" row.
  app.contentScripts.register({
    id: "filter-clear",
    mount({ signal }) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!event.metaKey || event.key !== "Backspace" || event.shiftKey || event.altKey) return;
        const input = document.activeElement;
        if (!(input instanceof HTMLInputElement) || input.getAttribute("aria-label") !== "Filter projects") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setValue?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        requestAnimationFrame(() => {
          const listId = input.getAttribute("aria-controls");
          const list = listId ? document.getElementById(listId) : null;
          const all = Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []).find(
            (option) => option.textContent?.trim() === "All projects",
          );
          all?.click();
        });
      };
      window.addEventListener("keydown", onKeyDown, { capture: true, signal });
    },
  });

  app.commands.register({
    id: "search-in-files",
    title: "Toggle search in files",
    defaultShortcut: { key: "f", mod: true, shift: true },
    run() {
      if (togglePage(FILES_PAGE)) focusWhenReady('input[placeholder="Search in files"]');
    },
  });
});
