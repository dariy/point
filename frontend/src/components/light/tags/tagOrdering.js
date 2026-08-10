/**
 * Sibling-ordering lookups shared by the tags manager's drag-and-drop and
 * its Move… dialog — the two paths that have to agree on where a tag lands.
 *
 * Both read the flat tag list rather than the tree the renderer builds: the
 * server sends an ordered `children` array on each tag, and that array is the
 * authority on sort order, not the child's own sort_order field.
 */

/** Children of parentId, in the parent's stored order. Unknown ids yield []. */
export function getChildrenOf(tags, parentId) {
  if (!parentId) return [];
  const parent = tags.find(t => t.id === parentId);
  if (!parent) return [];
  const childIds = (parent.children || []).map(c => c.id);
  return childIds.map(id => tags.find(t => t.id === id)).filter(Boolean);
}

/**
 * The id of the sibling just before targetId in parentId's children, or null
 * if targetId is first — which the move APIs read as "put it at the front".
 */
export function getSiblingBefore(tags, targetId, parentId) {
  const siblings = getChildrenOf(tags, parentId);
  const idx = siblings.findIndex(t => t.id === targetId);
  if (idx <= 0) return null;
  return siblings[idx - 1].id;
}
