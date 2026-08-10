/**
 * tagToggleTree — the behaviour of the editor modal's Parents/Children pickers.
 *
 * renderTagToggles (TagEditorForm.js) emits the markup; everything that makes it
 * behave like a tree lives here: the expand/collapse buttons, the search box
 * above each tree, and the indeterminate state that tells a user a collapsed
 * branch holds a checked tag.
 *
 * The indeterminate rule is the part worth naming. A checkbox is a tri-state
 * only in the DOM sense — the form submits checked boxes and nothing else — so
 * `indeterminate` here is purely a hint: "something below this is selected, but
 * this tag is not". It is never read back on save, which is why it can be
 * recomputed wholesale after any change rather than maintained incrementally.
 */

/** Rows a node owns beneath it — its own checkbox is not one of them. */
function descendantCheckboxes(node) {
  return node.querySelectorAll('.tag-toggle-node input[type="checkbox"]');
}

/** A node's own checkbox, not one belonging to a nested node. */
function ownCheckbox(node) {
  return node.querySelector(':scope > .tag-toggle-row .tag-toggle input[type="checkbox"]');
}

/**
 * Recompute the whole tree's indeterminate flags.
 *
 * Node order does not matter, because descendantCheckboxes reaches every depth
 * rather than one level: a checked grandchild is in its grandparent's set
 * directly, so nothing has to propagate upward a level at a time. The original
 * walked deepest-first and also counted an `indeterminate` descendant as
 * active; both were redundant for the same reason, and an indeterminate
 * descendant implies a checked one deeper still, already in this set.
 *
 * A checked box is never also indeterminate: the box already says "selected",
 * and browsers paint indeterminate over checked, which would hide that.
 */
export function syncIndeterminate(tree) {
  tree.querySelectorAll('.tag-toggle-node').forEach(node => {
    const ownCb = ownCheckbox(node);
    if (!ownCb) return;
    ownCb.indeterminate = !ownCb.checked
      && Array.from(descendantCheckboxes(node)).some(cb => cb.checked);
  });
}

/**
 * Show only the branches matching `query`, or all of them when it is empty.
 *
 * A match reveals itself and its ancestors, but not its children: the point of
 * searching is to find one tag, not to unfold the subtree under it. Ancestors
 * have to come back because hiding is per-element — a visible node inside a
 * hidden parent is still invisible.
 */
export function filterToggleTree(container, query) {
  const q = query.trim().toLowerCase();
  const allNodes = Array.from(container.querySelectorAll('.tag-toggle-node'));
  const allLists = Array.from(container.querySelectorAll('.tag-toggle-tree'));

  if (!q) {
    allNodes.forEach(n => n.classList.remove('hidden'));
    allLists.forEach(l => l.classList.remove('hidden'));
    return;
  }

  allNodes.forEach(n => n.classList.add('hidden'));
  allLists.forEach(l => l.classList.add('hidden'));

  allNodes.forEach(n => {
    const label = n.querySelector(':scope > .tag-toggle-row .tag-toggle span');
    if (label && label.textContent.toLowerCase().includes(q)) {
      let el = n;
      while (el && el !== container) {
        if (el.classList.contains('tag-toggle-node') || el.classList.contains('tag-toggle-tree')) {
          el.classList.remove('hidden');
        }
        el = el.parentElement;
      }
    }
  });
}

/** Flip one branch open or shut, keeping the arrow and aria-expanded with it. */
export function toggleBranch(root, btn) {
  const list = root.querySelector(`#${btn.dataset.ttToggle}`);
  if (!list) return;
  const open = !list.classList.contains('hidden');
  list.classList.toggle('hidden', open);
  btn.setAttribute('aria-expanded', String(!open));
  btn.textContent = open ? '▶' : '▼';
}

/**
 * Wire every toggle tree inside `root` (the open editor modal).
 *
 * Listeners are not torn down: the modal they are bound to is removed whole on
 * close, taking them with it.
 */
export function setupTagToggleTrees(root) {
  root.querySelectorAll('[data-tt-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleBranch(root, btn));
  });

  // The initial pass: the markup arrives with boxes already checked, and their
  // ancestors have no flags until something computes them.
  root.querySelectorAll('.tag-toggle-tree.level-0').forEach(tree => syncIndeterminate(tree));

  root.querySelectorAll('.tag-toggle-tree input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const tree = cb.closest('.tag-toggle-tree.level-0');
      if (tree) syncIndeterminate(tree);
    });
  });

  // Each search box filters the container that follows it — the pickers come in
  // pairs (Parents, Children) and must not filter each other.
  root.querySelectorAll('.tm-toggle-search').forEach(input => {
    const container = input.nextElementSibling;
    if (!container) return;
    input.addEventListener('input', () => filterToggleTree(container, input.value));
  });
}
