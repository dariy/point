import { PostGrid } from '../../components/public/PostGrid.ts';
import type { PostGridProps } from '../../components/public/PostGrid.ts';
import { attachHoverEffect } from './hover.ts';

export function mount(el: HTMLElement, ctx: PostGridProps) {
    attachHoverEffect();
    const comp = new PostGrid(el, ctx);
    comp.mount();
    return comp;
}
