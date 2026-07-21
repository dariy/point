# Nav Menu (`nav-menu`)

**Type:** slot · **Slot:** `nav-menu` · **Routes:** `/light/menu`, `/api/nav-menu`, `/api/pages/nav` · **Default:** enabled

The site navigation menu: fills the header's nav items, the burger menu's tag section,
and the burger's sitemap link. Fetches the menu tag tree once (cached in the shared
store) and refreshes it on login/logout or an explicit `nav-changed` event. Also owns
the admin menu editor at `/light/menu` (`MenuPage`), where the admin curates which tags
appear in the public nav. Disabling the plugin removes the nav menu (and its admin
editor) entirely — the header falls back to whatever other nav-adjacent plugins
([`breadcrumbs`](breadcrumbs.md), search) remain.
