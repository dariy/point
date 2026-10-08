import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach, afterEach } from "node:test";
import { setupDOM, must } from "./helpers/dom.ts";
import { fixtureTag } from "./helpers/tags.ts";
import { TagsInput } from "../src/components/light/TagsInput.ts";

test("TagsInput", async (t) => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  await t.test("initializes and renders", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const input = new TagsInput(root, { tags: ["hello", "world"] });
    input._allTags = [{ name: "hello", id: 1 }, { name: "world", id: 2 }, { name: "test", id: 3 }].map(fixtureTag);
    root.innerHTML = String(input.render());
    input.afterRender();

    const tagNodes = root.querySelectorAll(".tag-chip");
    assert.equal(tagNodes.length, 2);

    const textInput = must(root.querySelector<HTMLInputElement>("input[type='text']"), "text input");
    textInput.value = "te";
    textInput.dispatchEvent(new window.Event("input"));
    
    await new Promise(r => setTimeout(r, 250)); // wait for debounce
    const box = must(root.querySelector(".tags-suggestions"), "suggestions");
    assert.ok(box.classList.contains("show"));
    
    // add tag via Enter
    textInput.value = "newtag";
    const evt = Object.assign(new window.Event("keydown"), { key: "Enter" });
    textInput.dispatchEvent(evt);
    
    assert.ok(input.state.tags.includes("newtag"));
    
    // delete tag
    const xBtn = must(root.querySelector<HTMLElement>(".tag-remove"), "remove button");
    xBtn.click();
    assert.ok(!input.state.tags.includes("hello"));
    
    root.remove();
  });
});
