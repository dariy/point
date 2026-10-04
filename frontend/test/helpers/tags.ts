/**
 * Tag fixtures for the tag tests.
 *
 * A fixture tag holds only the fields the code under test reads, and its
 * parent and child stubs often hold only an id. `fixtureTag()` states that
 * once, here, so a test does not cast at each call site.
 */

import type { Tag, TagStub } from '../../src/api/tags.ts';
import type { TagNode, TreeTag } from '../../src/components/light/tags/TagTreeView.ts';

/** Any tag fields, with parent, child and location entries that may be partial. */
export type TagFixture = Omit<Partial<TreeTag>, 'parents' | 'children' | 'locations'> & {
  parents?: Partial<TagStub>[];
  children?: Partial<TagStub>[];
  locations?: Partial<Tag['locations'][number]>[];
};

/** Use a fixture where the code under test expects a full tag. */
export function fixtureTag(fields: TagFixture): TreeTag {
  return fields as TreeTag;
}

/** Use a fixture where the code under test expects a tree node. */
export function fixtureNode(fields: TagFixture & { childrenNodes?: TagNode[] }): TagNode {
  return fields as TagNode;
}
