import { PublicFooter } from './PublicFooter.ts';
import type { PublicFooterProps } from './PublicFooter.ts';

export function mount(el: HTMLElement, ctx: PublicFooterProps) {
  const comp = new PublicFooter(el, ctx);
  comp.mount();
  return comp;
}
