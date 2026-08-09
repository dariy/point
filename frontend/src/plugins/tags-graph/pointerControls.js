/**
 * pointerControls.js — the /tags graph's gestures.
 *
 * One pointer on a node drags it; one on empty space pans the view; two pinch.
 * A press that neither travels far nor lasts long is a tap, and taps are the
 * two-stage select-then-open interaction the graph is navigated with.
 *
 * This owns the gesture state (which pointers are down, where the press
 * started, whether it has moved past the slop) and the view transform while a
 * pan or pinch is in flight. What a gesture *means* — what a tap selects, what
 * a drag does to the layout — is the host's, so the two can be read apart.
 *
 * Host contract (TagGraph implements it):
 *   scale, tx, ty            the view transform, read and written here
 *   _needFit, _userView      auto-framing flags; a gesture turns them off
 *   dragNode, panning        interaction state the sim and the rAF loop read
 *   _pickNode(sx, sy)        hit-test, screen coords → node | null
 *   _screenToWorld(sx, sy)
 *   _fitScale()              minimum zoom ("everything visible")
 *   _zoomAt(sx, sy, factor)  zoom about a screen point
 *   _dragTo(node, sx, sy)    move a held node under the pointer
 *   _handleTap(node|null)    select / open / clear
 *   _setHover(node|null)
 *   _draw(), _kick()
 */

import { clamp, MAX_SCALE } from './viewport.js';

const TAP_SLOP = 10; // max screen-px drift still counted as a tap (not a drag)
const TAP_MS = 400; // and the longest press that still counts

export class PointerControls {
  constructor(canvas, host) {
    this.canvas = canvas;
    this.host = host;

    this._pointers = new Map(); // pointerId -> {x,y}, for multi-touch pinch
    this._pinch = null;
    this._downPos = null;
    this._downTime = 0;
    this._moved = false;
    this._panStart = null;

    this._onDown = (e) => this.pointerDown(e);
    this._onMove = (e) => this.pointerMove(e);
    this._onUp = (e) => this.pointerUp(e);
    this._onWheel = (e) => this.wheel(e);
    this._onLeave = (e) => {
      // On touch, lifting a finger fires pointerleave — don't wipe the
      // tap-selected node (that highlight must persist until the next tap).
      if (e && e.pointerType === 'touch') return;
      this.host._setHover(null);
    };

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('pointerleave', this._onLeave);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _capture(pointerId) {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }
  }

  /** Mark the gesture a drag once it clears the slop, so it is no longer a tap. */
  _trackTravel(p) {
    if (this._downPos && Math.hypot(p.x - this._downPos.x, p.y - this._downPos.y) > TAP_SLOP) {
      this._moved = true;
      return true;
    }
    return false;
  }

  pointerDown(e) {
    const host = this.host;
    const p = this._pos(e);
    this._pointers.set(e.pointerId, p);
    host._needFit = false; // user is taking over the view

    // A second finger turns the gesture into a pinch — drop any single-pointer
    // drag/pan that the first finger started.
    if (this._pointers.size === 2) {
      host.dragNode = null;
      host.panning = false;
      this._beginPinch();
      this._capture(e.pointerId);
      return;
    }
    if (this._pointers.size > 2) return;

    const node = host._pickNode(p.x, p.y);
    this._downPos = p;
    this._downTime = Date.now();
    this._moved = false;
    if (node) {
      host.dragNode = node;
      host._kick();
    } else {
      host.panning = true;
      this._panStart = { x: p.x - host.tx, y: p.y - host.ty };
    }
    this._capture(e.pointerId);
  }

  _beginPinch() {
    const [a, b] = [...this._pointers.values()];
    this._pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: this.host.scale,
      // World point under the initial midpoint, kept fixed for the gesture.
      world: this.host._screenToWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
    this._moved = true; // suppress tap-navigation when the gesture ends
  }

  pointerMove(e) {
    const host = this.host;
    const p = this._pos(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, p);

    // Pinch: scale by the finger-distance ratio, anchored on the moving
    // midpoint (which also yields two-finger panning).
    if (this._pinch && this._pointers.size >= 2) {
      host._userView = true;
      const [a, b] = [...this._pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      host.scale = clamp(this._pinch.startScale * (dist / this._pinch.startDist), host._fitScale(), MAX_SCALE);
      host.tx = midX - this._pinch.world.x * host.scale;
      host.ty = midY - this._pinch.world.y * host.scale;
      host._draw();
      return;
    }

    if (host.dragNode) {
      // Ignore sub-slop jitter so a stationary tap still registers as a tap.
      this._trackTravel(p);
      host._dragTo(host.dragNode, p.x, p.y);
      return;
    }
    if (host.panning) {
      if (this._trackTravel(p)) host._userView = true;
      host.tx = p.x - this._panStart.x;
      host.ty = p.y - this._panStart.y;
      host._draw();
      return;
    }
    host._setHover(host._pickNode(p.x, p.y));
  }

  pointerUp(e) {
    const host = this.host;
    this._pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    // Lifting a finger out of a pinch. If one finger remains, hand it back to
    // single-finger panning without a jump; otherwise the gesture is over.
    if (this._pinch) {
      if (this._pointers.size < 2) {
        this._pinch = null;
        const rest = [...this._pointers.values()][0];
        if (rest) {
          host.panning = true;
          this._panStart = { x: rest.x - host.tx, y: rest.y - host.ty };
        }
      }
      host._draw();
      return;
    }

    const wasDrag = host.dragNode;
    const wasPan = host.panning;
    host.dragNode = null;
    host.panning = false;

    // Treat a short, near-stationary press as a tap/click.
    if (this._downPos && !this._moved && Date.now() - this._downTime < TAP_MS) {
      host._handleTap(host._pickNode(this._downPos.x, this._downPos.y));
      return;
    }
    if (wasDrag || wasPan) host._draw();
  }

  wheel(e) {
    e.preventDefault();
    const p = this._pos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.host._zoomAt(p.x, p.y, factor);
  }
}
