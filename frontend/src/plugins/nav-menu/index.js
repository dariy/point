import { store } from '../../store.js';
import { getNavMenu } from './api.js';
import { NavMenu } from './NavMenu.js';
import MenuPage from './MenuPage.js';

let fetching = false;

export async function mount(navEl, ctx) {
  // Only mount if the elements exist
  const navItemsEl = navEl.querySelector('.site-nav-items');
  const burgerTagsEl = navEl.querySelector('#burger-tags-slot');
  const burgerSitemapEl = navEl.querySelector('.burger-sitemap');

  if (!navItemsEl || !burgerTagsEl || !burgerSitemapEl) return null;

  const comp = new NavMenu({
    navItemsEl,
    burgerTagsEl,
    burgerSitemapEl,
    ctx
  });

  // Fetch nav tags once
  if (!store.get('navTags') && !fetching) {
    fetching = true;
    try {
      const data = await getNavMenu();
      store.set('navTags', data.menu || []);
    } catch {
      // ignore
    } finally {
      fetching = false;
    }
  }

  // Also refresh on user login/logout or explicit nav-changed event
  const refresh = async () => {
    try {
      const data = await getNavMenu();
      store.set('navTags', data.menu || []);
    } catch { /* ignore */ }
  };

  const unsubscribeUser = store.subscribe('user', refresh);
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
