import test from "node:test";
import assert from "node:assert/strict";
import { showConfirm, showPrompt } from "../src/utils/dialogs.js";
import { beforeEach, afterEach } from "node:test";
import { setupDOM } from "./helpers/dom.js";

test("dialogs", async (t) => {
  let dom;
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
    
    const confirmBtn = document.querySelector(".btn-primary");
    confirmBtn.click();
  });

  await t.test("showConfirm mounts and handles cancel", () => {
    showConfirm({
      title: "Test Confirm Cancel",
      message: "Sure?",
    });
    assert.ok(document.body.innerHTML.includes("Test Confirm Cancel"));
    
    const cancelBtn = document.querySelector(".btn-secondary");
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
    
    const input = document.querySelector("input");
    input.value = "bar";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    
    const confirmBtn = document.querySelector(".btn-primary");
    confirmBtn.click();
  });

  await t.test("showPrompt handles cancel", () => {
    showPrompt({
      title: "Test Prompt Cancel",
      message: "Enter name:",
    });
    assert.ok(document.body.innerHTML.includes("Test Prompt Cancel"));
    
    const cancelBtn = document.querySelector(".btn-secondary");
    cancelBtn.click();
    assert.ok(!document.body.innerHTML.includes("Test Prompt Cancel"));
  });
});
