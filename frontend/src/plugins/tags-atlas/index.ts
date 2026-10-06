/**
 * tags-atlas route entry — the old `/map` URL.
 *
 * The map is a layer on every post list page now (see atlasLayerState.ts). A
 * link to `/map` still works: it opens the home list in the `map` state. Old
 * query parameters stay on the URL.
 */

import { Component } from "../../components/Component.ts";
import { html, navigate } from "../../utils/helpers.ts";
import { searchWithState } from "./atlasLayerState.ts";

/** The home-list URL that `/map` redirects to. */
export function mapRedirectTarget(search: string): string {
  return "/" + searchWithState(search, "map");
}

export default class AtlasMapRedirect extends Component {
  render() {
    return html``;
  }

  afterRender() {
    navigate(mapRedirectTarget(location.search), { replace: true });
  }
}
