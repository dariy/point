/**
 * dialogs — imperative confirm/prompt helpers.
 *
 * Mounts a ConfirmDialog/PromptDialog into a throwaway node on <body> and tears
 * it down on either outcome. Extracted from the admin pages (SystemPage,
 * SecurityPage) so the per-plugin section components can reuse the same pattern.
 */

import { ConfirmDialog } from "../components/shared/ConfirmDialog.js";
import { PromptDialog } from "../components/shared/PromptDialog.js";

/**
 * @param {{title:string, message:string, confirmText?:string,
 *   variant?:'primary'|'danger', allowHtml?:boolean, onConfirm?:Function}} opts
 */
export function showConfirm({ title, message, confirmText, variant = "primary", allowHtml, onConfirm }) {
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

/**
 * @param {{title:string, message:string, defaultValue?:string,
 *   inputType?:'text'|'password', confirmText?:string,
 *   onConfirm?:(value:string)=>void}} opts
 */
export function showPrompt({ title, message, defaultValue = "", inputType = "text", confirmText, onConfirm }) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const dialog = new PromptDialog(mount, {
    title,
    message,
    defaultValue,
    inputType,
    confirmText,
    onConfirm: (val) => { dialog.unmount(); mount.remove(); onConfirm?.(val); },
    onCancel: () => { dialog.unmount(); mount.remove(); },
  });
  dialog.mount();
}
