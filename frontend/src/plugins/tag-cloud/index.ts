import { ExploreBlock } from "./ExploreBlock.ts";
import type { ExploreBlockProps } from "./ExploreBlock.ts";

export function mount(el: HTMLElement, ctx: ExploreBlockProps) {
  const comp = new ExploreBlock(el, ctx);
  comp.mount();
  return comp;
}
