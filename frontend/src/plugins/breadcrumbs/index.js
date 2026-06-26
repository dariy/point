import { Breadcrumbs } from './Breadcrumbs.js';

export function mount(el, ctx) {
  const comp = new Breadcrumbs(el, ctx);
  comp.mount();
  return {
    unmount: () => comp.unmount()
  };
}
