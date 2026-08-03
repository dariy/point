/**
 * Entry point for the static demo build (scripts/build-demo.sh).
 *
 * Import order is the whole trick: the shim patches window.fetch and
 * XMLHttpRequest as a side effect of being imported, and ES modules evaluate in
 * order, so it is installed before app.js runs its top-level loadThemeCss()
 * fetch and before anything else touches the network.
 *
 * app.js itself is imported unmodified — the demo runs the real application,
 * not a copy of it.
 */

import "./shim.js";
import "./banner.js";
import "../app.js";
