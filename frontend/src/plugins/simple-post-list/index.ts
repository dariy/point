import { PostGrid } from '../../components/public/PostGrid.ts';
import type { PostGridProps } from '../../components/public/PostGrid.ts';

export function mount(el: HTMLElement, ctx: PostGridProps) {
    const comp = new PostGrid(el, ctx);
    comp.mount();
    return comp;
}
