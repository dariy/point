import { PostGrid } from '../../components/public/PostGrid.js';
import { attachHoverEffect } from './hover.js';

export function mount(el, ctx) {
    attachHoverEffect();
    const comp = new PostGrid(el, ctx);
    comp.mount();
    return comp;
}
