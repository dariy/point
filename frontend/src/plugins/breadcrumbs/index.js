import { Breadcrumbs } from './Breadcrumbs.js';
import { loadNav } from '../../api/nav.js';

export function mount(el, ctx) {
  // The site crumb's root-tag dropdown needs the nav payload even when the
  // nav-menu plugin (its usual loader) is disabled. Shared and de-duplicated,
  // so the common case stays one request; the crumb re-renders when it lands.
  loadNav();

  const comp = new Breadcrumbs(el, ctx);
  comp.mount();
  return {
    unmount: () => comp.unmount()
  };
}
