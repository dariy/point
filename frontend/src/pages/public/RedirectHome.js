/**
 * RedirectHome — tiny placeholder page that immediately bounces to "/".
 *
 * Used by the /tags route when no tags-viz plugin is enabled ("none") or the
 * feature is restricted to admins for a logged-out visitor. Rendering nothing
 * and redirecting in afterRender() keeps the behaviour entirely client-side.
 */

import { Component } from "../../components/Component.js";
import { navigate } from "../../utils/helpers.js";

export default class RedirectHome extends Component {
  render() {
    return "";
  }

  afterRender() {
    navigate("/", { replace: true });
  }
}
