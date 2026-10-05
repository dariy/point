import test from "node:test";
import assert from "node:assert/strict";
import { showConfirm, showPrompt } from "../src/utils/dialogs.ts";
import { beforeEach, afterEach } from "node:test";
import { setupDOM, must } from "./helpers/dom.ts";

test("dialogs", async (t) => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  await t.test("showConfirm mounts and calls onConfirm", (t, done) => {
    showConfirm({
      title: "Test Confirm",
      message: "Are you sure?",
      onConfirm: () => {
        assert.ok(!document.body.innerHTML.includes("Test Confirm"));
        done();
      }
    });
    
    assert.ok(document.body.innerHTML.includes("Test Confirm"));
    assert.ok(document.body.innerHTML.includes("Are you sure?"));
    
    const confirmBtn = must(document.querySelector<HTMLElement>(".btn-primary"), "confirm button");
    confirmBtn.click();
  });

  await t.test("showConfirm mounts and handles cancel", () => {
    showConfirm({
      title: "Test Confirm Cancel",
      message: "Sure?",
    });
    assert.ok(document.body.innerHTML.includes("Test Confirm Cancel"));
    
    const cancelBtn = must(document.querySelector<HTMLElement>(".btn-secondary"), "cancel button");
    cancelBtn.click();
    assert.ok(!document.body.innerHTML.includes("Test Confirm Cancel"));
  });

  await t.test("showPrompt mounts and calls onConfirm with value", (t, done) => {
    showPrompt({
      title: "Test Prompt",
      message: "Enter name:",
      defaultValue: "foo",
      onConfirm: (val) => {
        assert.equal(val, "bar");
        assert.ok(!document.body.innerHTML.includes("Test Prompt"));
        done();
      }
    });
    
    assert.ok(document.body.innerHTML.includes("Test Prompt"));
    assert.ok(document.body.innerHTML.includes("Enter name:"));
    
    const input = must(document.querySelector("input"), "prompt input");
    input.value = "bar";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    
    const confirmBtn = must(document.querySelector<HTMLElement>(".btn-primary"), "confirm button");
    confirmBtn.click();
  });

  await t.test("showPrompt handles cancel", () => {
    showPrompt({
      title: "Test Prompt Cancel",
      message: "Enter name:",
    });
    assert.ok(document.body.innerHTML.includes("Test Prompt Cancel"));
    
    const cancelBtn = must(document.querySelector<HTMLElement>(".btn-secondary"), "cancel button");
    cancelBtn.click();
    assert.ok(!document.body.innerHTML.includes("Test Prompt Cancel"));
  });
});
