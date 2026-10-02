/**
 * Responsive compact mode for .light-header.
 *
 * When the h1 title and .header-actions overlap on the same line, adds
 * class "compact" to .light-header so buttons collapse to icon-only mode.
 */

export function setupHeaderCompact(header) {
  if (!header) return () => {};
  const h1 = header.querySelector('h1');
  const actions = header.querySelector('.header-actions');
  if (!h1 || !actions) return () => {};

  function check() {
    // Measure without compact so we get natural sizes.
    header.classList.remove('compact');

    const titleRow = header.querySelector('.header-title-row');
    const actionsRect = actions.getBoundingClientRect();

    let contentOverflows = false;
    let maxRight = 0;

    if (titleRow) {
      for (const child of titleRow.children) {
        if (child.scrollWidth > child.clientWidth) {
          contentOverflows = true;
        }
        maxRight = Math.max(maxRight, child.getBoundingClientRect().right);
      }
    } else {
      const h1Rect = h1.getBoundingClientRect();
      maxRight = h1Rect.right;
      if (h1.scrollWidth > h1.clientWidth) contentOverflows = true;
    }

    // Only collapse when both are on the same line (same-row check via top).
    const h1Rect = h1.getBoundingClientRect();
    const sameRow = Math.abs(h1Rect.top - actionsRect.top) < actionsRect.height;
    
    if (sameRow && (contentOverflows || maxRight + 16 >= actionsRect.left)) {
      header.classList.add('compact');
    }
  }

  const ro = new ResizeObserver(check);
  ro.observe(header);
  check();
  return () => ro.disconnect();
}
