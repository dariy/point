import { PublicFooter } from './PublicFooter.js';

export function mount(el, ctx) {
  const comp = new PublicFooter(el, ctx);
  comp.mount();
  return comp;
}
