// Guard fixture for typescript-strip.test.ts: it holds type syntax that
// only a Node which removes types can load.
export interface Pair {
    a: number;
    b: number;
}

export function sum(pair: Pair): number {
    return pair.a + pair.b;
}
