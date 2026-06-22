import { ExploreBlock } from "./ExploreBlock.js";

export function mount(el, ctx) {
  const comp = new ExploreBlock(ctx);
  comp.mount(el);
  return comp;
}
