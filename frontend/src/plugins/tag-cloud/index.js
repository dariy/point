import { ExploreBlock } from "./ExploreBlock.js";

export function mount(el, ctx) {
  const comp = new ExploreBlock(el, ctx);
  comp.mount();
  return comp;
}
