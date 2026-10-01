/**
 * dialogs — imperative confirm/prompt helpers.
 *
 * Mounts a ConfirmDialog/PromptDialog into a throwaway node on <body> and tears
 * it down on either outcome. Extracted from the admin pages (SystemPage,
 * SecurityPage) so the per-plugin section components can reuse the same pattern.
 */

import { ConfirmDialog } from "../components/shared/ConfirmDialog.js";
import { PromptDialog } from "../components/shared/PromptDialog.js";
import type { RawHtml } from "./helpers.ts";

/**
 * @param opts
 *   With `allowHtml` the message renders as markup, so it must be built with
 *   the html`` tag; a plain string is escaped and shows as text.
 */
export function showConfirm({ title, message, confirmText, variant = "primary", allowHtml, onConfirm }: {
  title: string;
  message: string | RawHtml;
  confirmText?: string;
  variant?: 'primary' | 'danger';
  allowHtml?: boolean;
  onConfirm?: Function;
}) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const dialog = new ConfirmDialog(mount, {
    title,
    message,
    confirmText,
    variant,
    allowHtml,
    onConfirm: () => { dialog.unmount(); mount.remove(); onConfirm?.(); },
    onCancel: () => { dialog.unmount(); mount.remove(); },
  });
  dialog.mount();
}

export function showPrompt({ title, message, defaultValue = "", inputType = "text", variant = "primary", confirmText, onConfirm }: {
  title: string;
  message: string;
  defaultValue?: string;
  inputType?: 'text' | 'password';
  variant?: 'primary' | 'danger';
  confirmText?: string;
  onConfirm?: (value:string)=>void;
}) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const dialog = new PromptDialog(mount, {
    title,
    message,
    defaultValue,
    inputType,
    variant,
    confirmText,
    onConfirm: (val) => { dialog.unmount(); mount.remove(); onConfirm?.(val); },
    onCancel: () => { dialog.unmount(); mount.remove(); },
  });
  dialog.mount();
}
