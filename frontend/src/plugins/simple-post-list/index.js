import { PostGrid } from '../../components/public/PostGrid.js';

export function mount(el, ctx) {
    const comp = new PostGrid(el, ctx);
    comp.mount();
    return comp;
}
