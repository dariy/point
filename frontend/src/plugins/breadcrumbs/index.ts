import { Breadcrumbs } from './Breadcrumbs.ts';
import type { BreadcrumbsProps } from './Breadcrumbs.ts';

export function mount(el: HTMLElement, ctx: BreadcrumbsProps) {
  const comp = new Breadcrumbs(el, ctx);
  comp.mount();
  return {
    unmount: () => comp.unmount()
  };
}
