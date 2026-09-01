import { onUser } from '../../store.js';
import { loadNav } from '../../api/nav.js';
import { NavMenu } from './NavMenu.js';
import MenuPage from './MenuPage.js';

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
