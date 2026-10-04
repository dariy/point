# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

- Test helpers for typed tests: `helpers/mock.ts` (`mock<T>`, `spy`, `memoryStorage(map)`, `nodeList(items)`), `helpers/dom.ts` (`setupDOM`, `must`, `fire`, `click`), `helpers/fetch.ts` (`jsonResponse`), `helpers/stubElement.ts` (`StubElement` + `asElement`/`asStub` for hand-rolled element stubs, `callListener` for listeners stored as `EventListenerOrEventListenerObject`).
- Overloaded lib members (`getContext`, `window.addEventListener`): a single-signature stub does not fit. Take `EventListenerOrEventListenerObject` for listeners; for `getContext` use the one commented boundary cast (see tagGraph/videoPoster tests).
- The test lib has no `Array.prototype.at`: use `list[list.length - 1]` or a `last()` helper with `must`.
- A read-only lib property that a test changes (`documentElement.scrollHeight`, `navigator.clipboard`): keep a plain object and `mock<T>(obj)` it, or `Object.assign` onto the global.

---


## 2026-10-04 - p-ts-tests-mf3t.6
- Converted the 16 media and grid tests to `.ts` and typed them. Lowered JS_TEST_BASELINE 48 -> 32. node --test total 1707 before and after.
- Files changed: frontend/test/{MediaBrowser,MediaViewer,adminThumbnails,exif,gestures,gridFlip,gridPager,gridPerPage,gridZoom,imageCache,mediaByPaths,mediaFolderChips,mediaPager,mediaUrl,swMediaCache,videoPoster}.test.ts, frontend/test/helpers/mock.ts (memoryStorage, nodeList), frontend/test/helpers/stubElement.ts (new), scripts/check.sh.
- **Learnings:**
  - exif.test used a hand-rolled DOM; setupDOM (linkedom) replaced it with no change to the assertions.
  - The CustomEvent stubs in gridZoom/gridPerPage were not necessary: Node has a global CustomEvent.
  - A class stub (FakeVideo, StubElement) with typed fields is easier to type than an object literal that uses `this`.
  - go-test TestRebuildThumbnails_ReturnsWithoutDecodingTheLibrary can fail under check.sh load ("prewarm did not finish"). It passes alone. Run check.sh again.
---
