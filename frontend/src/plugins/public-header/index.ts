import { PublicHeader } from './PublicHeader.ts';
import type { PublicHeaderProps } from './PublicHeader.ts';

export function mount(el: HTMLElement, ctx: PublicHeaderProps) {
  const comp = new PublicHeader(el, ctx);
  comp.mount();
  return comp;
}
