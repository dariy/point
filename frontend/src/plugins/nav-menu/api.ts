import { api } from '../../api/client.ts';
import type { NavTagNode } from '../../api/nav.ts';

/** The nav menu config as the server stores it. */
export interface NavMenuConfig {
  mode: string;
  items: NavTagNode[];
  custom_markdown: string;
  inline_max: number;
  more_title: string;
}

/** The admin read of the config, plus the tags-mode tree. */
export interface AdminNavMenu extends NavMenuConfig {
  tag_items: NavTagNode[];
}

/** The fields an admin save sends. */
/** One authored custom link in a save payload; children nest by depth. */
export interface NavMenuItemInput {
  name: string;
  url: string;
  children: NavMenuItemInput[];
}

export interface NavMenuUpdate {
  mode: string;
  items: NavMenuItemInput[];
  custom_markdown?: string;
  inline_max?: number;
  more_title?: string;
}

/**
 * Admin: get current nav menu config (mode + custom items).
 *
 * `tag_items` is the tags-mode tree, sent whatever the active mode is so the
 * editor can preview a mode switch before saving — see GetAdminNavMenu in
 * api/internal/api/nav_menu.go.
 */
export function getAdminNavMenu(): Promise<AdminNavMenu> {
  return api.get('/api/nav-menu');
}

/**
 * Admin: save nav menu config.
 *
 * @returns The saved config. An `inline_max` outside 1–10 keeps the stored
 *   value, and an empty `more_title` becomes "More".
 */
export function updateAdminNavMenu(data: NavMenuUpdate): Promise<NavMenuConfig> {
  return api.put('/api/nav-menu', data);
}
