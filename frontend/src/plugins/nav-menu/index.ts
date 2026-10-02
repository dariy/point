import { onUser } from '../../store.ts';
import { loadNav } from '../../api/nav.ts';
import { NavMenu } from './NavMenu.ts';
import type { NavMenuCtx } from './NavMenu.ts';
import MenuPage from './MenuPage.ts';

export async function mount(navEl: HTMLElement, ctx: NavMenuCtx) {
  // Only mount if the elements exist
  const navItemsEl = navEl.querySelector<HTMLElement>('.site-nav-items');
  const burgerTagsEl = navEl.querySelector<HTMLElement>('#burger-tags-slot');
  const burgerSitemapEl = navEl.querySelector<HTMLElement>('.burger-sitemap');

  if (!navItemsEl || !burgerTagsEl || !burgerSitemapEl) return null;

  const comp = new NavMenu({
    navItemsEl,
    burgerTagsEl,
    burgerSitemapEl,
    ctx
  });

  // Fetch nav tags once
  await loadNav();

  // Also refresh on user login/logout or explicit nav-changed event
  const refresh = () => loadNav({ force: true });

  const unsubscribeUser = onUser(refresh);
  const onNavChanged = () => refresh();
  document.addEventListener('nav-changed', onNavChanged);

  comp.mount();

  return {
    unmount: () => {
      comp.unmount();
      unsubscribeUser();
      document.removeEventListener('nav-changed', onNavChanged);
    }
  };
}

export default MenuPage;
