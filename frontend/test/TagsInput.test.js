// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach, afterEach } from "node:test";
import { setupDOM } from "./helpers/dom.js";
import { TagsInput } from "../src/components/light/TagsInput.js";

test("TagsInput", async (t) => {
  let dom;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  await t.test("initializes and renders", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const input = new TagsInput(root, { tags: ["hello", "world"] });
    input._allTags = [{ name: "hello", id: 1 }, { name: "world", id: 2 }, { name: "test", id: 3 }];
    root.innerHTML = input.render();
    input.afterRender();

    const tagNodes = root.querySelectorAll(".tag-chip");
    assert.equal(tagNodes.length, 2);

    const textInput = root.querySelector("input[type='text']");
    textInput.value = "te";
    textInput.dispatchEvent(new window.Event("input"));
    
    await new Promise(r => setTimeout(r, 250)); // wait for debounce
    const box = root.querySelector(".tags-suggestions");
    assert.ok(box.classList.contains("show"));
    
    // add tag via Enter
    textInput.value = "newtag";
    const evt = new window.Event("keydown");
    evt.key = "Enter";
    textInput.dispatchEvent(evt);
    
    assert.ok(input.state.tags.includes("newtag"));
    
    // delete tag
    const xBtn = root.querySelector(".tag-remove");
    xBtn.click();
    assert.ok(!input.state.tags.includes("hello"));
    
    root.remove();
  });
});
