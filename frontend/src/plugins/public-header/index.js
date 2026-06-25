import { PublicHeader } from './PublicHeader.js';

export function mount(el, ctx) {
  const comp = new PublicHeader(el, ctx);
  comp.mount();
  return comp;
}
