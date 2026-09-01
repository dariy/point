/**
 * reconcileList — bring a container's children into line with a list, keyed.
 *
 * The default `Component._rerender()` has one strategy: throw the subtree away
 * and write a new one. That is right for most things and wrong for anything
 * where DOM identity carries state the markup does not — a decoded <img>, a
 * running animation, a focused field, a scroll offset. Every place in this
 * codebase that could not afford the rebuild invented its own way around it,
 * and the shape they all wanted was the same one: "same list, slightly
 * different — keep the nodes that are staying".
 *
 * Keys, not positions, are what make that possible. Given `keyOf`, a node is
 * matched to the item it was created for however the list has been reordered,
 * so the surviving nodes are moved rather than rebuilt. The key is stored on
 * the node itself (`data-rkey`), because the alternative — a Map held by the
 * caller — is one more thing to keep in step with the DOM, and the DOM is
 * already the record.
 *
 * Order of operations is deliberate. Departures are detached first, then the
 * arrivals and survivors are walked into place against a cursor. Removing
 * first means a list that only lost a middle element needs zero moves: the
 * cursor meets each survivor exactly where it already is. Doing it the other
 * way round would drag every node after the gap past a corpse.
 *
 * What this does NOT do:
 *   - It does not own foreign children. An element without `data-rkey` is
 *     something else's — it is never moved, keyed, or removed. It does occupy
 *     a position, so a container that mixes managed and unmanaged children
 *     will see extra moves; give the reconciler its own element if that
 *     matters.
 *   - It does not animate an exit. `remove(node)` is called for teardown while
 *     the node is still in the document, and the node is detached immediately
 *     after. A component that wants a departure animation owns the node's
 *     lifetime itself and should not hand it here.
 */

/** The dataset property the key is stored under (`data-rkey` in markup). */
const KEY = 'rkey';

/** The attribute form of the above, for tests and for reading a node's key. */
export const KEY_ATTR = 'data-rkey';

/**
 * Stamp the key a node will be matched by.
 *
 * Nodes built by `create` are stamped for you. This is for the other half: the
 * first render, where the markup came out of render() and the association
 * between a node and the item it stands for is made in afterRender(). Doing it
 * there rather than writing `data-rkey` into the template keeps the attribute
 * name in one place, and keeps the template from having to know it exists.
 *
 * @param {HTMLElement} node
 * @param {string|number} key
 */
export function setKey(node, key) {
  if (node?.dataset) node.dataset[KEY] = String(key);
}

/**
 * @typedef {object} ReconcileOps
 * @property {(item: any, index: number) => HTMLElement} create
 *   Build the node for an item the container does not have yet. Returned
 *   detached; the reconciler inserts it and stamps the key.
 * @property {(node: HTMLElement, item: any, index: number) => void} [update]
 *   Called for every surviving node, with its new item and its new index —
 *   the index is where a positional attribute (`data-index`, an aria label)
 *   gets corrected after a reorder.
 * @property {(node: HTMLElement, key: string) => void} [remove]
 *   Called for a node whose key is gone, while it is still in the document, so
 *   a child component can be unmounted against live DOM. The reconciler
 *   detaches the node afterwards either way.
 */

/**
 * @typedef {object} ReconcileResult
 * @property {HTMLElement[]} created  Nodes built by `create`, in list order.
 * @property {HTMLElement[]} removed  Nodes detached, in the order found.
 * @property {HTMLElement[]} nodes    One node per item, in list order — the
 *   caller's handle for rebuilding whatever it indexes by position.
 * @property {number} moved  Survivors that had to be re-inserted. Zero is the
 *   good case and is what the tests assert on: it means nothing shifted.
 */

/**
 * @param {HTMLElement} container  The parent whose children are managed.
 * @param {ArrayLike<any>} items   The list the children should end up matching.
 * @param {(item: any, index: number) => string|number} keyOf  Stable identity.
 * @param {ReconcileOps} ops
 * @returns {ReconcileResult}
 */
export function reconcileList(container, items, keyOf, ops) {
  if (!container) throw new TypeError('reconcileList: no container');
  if (typeof ops?.create !== 'function') {
    throw new TypeError('reconcileList: ops.create is required');
  }

  const list = Array.from(items || []);
  const keys = list.map((item, i) => String(keyOf(item, i)));

  const wanted = new Set();
  for (const key of keys) {
    // A duplicate key silently loses a node — the second item matches the same
    // survivor, and the first one's node is left unclaimed and then removed.
    // Louder here than three renders later, where it presents as a card that
    // vanished for no reason.
    if (wanted.has(key)) throw new Error(`reconcileList: duplicate key "${key}"`);
    wanted.add(key);
  }

  /** @type {Map<string, HTMLElement>} */
  const existing = new Map();
  for (const node of Array.from(container.children)) {
    const key = node.dataset?.[KEY];
    if (key !== undefined) existing.set(key, node);
  }

  const removed = [];
  for (const [key, node] of existing) {
    if (wanted.has(key)) continue;
    existing.delete(key);
    ops.remove?.(node, key);
    node.remove();
    removed.push(node);
  }

  const created = [];
  const nodes = [];
  let moved = 0;
  // Everything already placed sits before the cursor; the cursor is the next
  // child that has not been accounted for.
  let cursor = container.firstElementChild;

  for (let i = 0; i < list.length; i++) {
    const key = keys[i];
    let node = existing.get(key);

    if (node) {
      ops.update?.(node, list[i], i);
    } else {
      node = ops.create(list[i], i);
      if (node?.dataset) node.dataset[KEY] = key;
      created.push(node);
    }

    if (node === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      // insertBefore(node, null) appends, which is the past-the-end case.
      container.insertBefore(node, cursor);
      if (existing.has(key)) moved++;
    }
    nodes.push(node);
  }

  return { created, removed, nodes, moved };
}
