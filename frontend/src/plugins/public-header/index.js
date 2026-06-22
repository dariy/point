import { PublicHeader } from './PublicHeader.js';

export function mount(el, ctx) {
  return new PublicHeader(el, ctx);
}
