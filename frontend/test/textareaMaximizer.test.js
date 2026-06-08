import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('textareaMaximizer', () => {
  let setupTextareaMaximizer;

  before(async () => {
    // Basic DOM Mocks
    global.window = {
      getComputedStyle: () => ({ position: 'static' })
    };
    global.document = {
      createElement: (tag) => {
        const el = {
          tag,
          classList: new Set(),
          style: {},
          dataset: {},
          addEventListener: (event, handler) => {
            el.listeners = el.listeners || {};
            el.listeners[event] = handler;
          },
          appendChild: (child) => {
            el.children = el.children || [];
            el.children.push(child);
            child.parentElement = el;
          },
          dispatchEvent: (event) => {
            el.dispatched = el.dispatched || [];
            el.dispatched.push(event);
          }
        };
        el.classList.add = (c) => {
          const set = el.classList;
          Set.prototype.add.call(set, c);
        };
        el.classList.toggle = (c) => {
          if (el.classList.has(c)) {
            el.classList.delete(c);
            return false;
          } else {
            el.classList.add(c);
            return true;
          }
        };
        return el;
      },
      body: {
        classList: {
          add: () => {},
          remove: () => {}
        }
      }
    };

    const mod = await import('../src/utils/textareaMaximizer.js');
    setupTextareaMaximizer = mod.setupTextareaMaximizer;
  });

  test('should add maximize button to textarea', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: (c) => {
          textarea.isMaximized = !textarea.isMaximized;
          return textarea.isMaximized;
        },
        add: () => {},
        contains: (c) => textarea.isMaximized
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: () => {},
      parentElement: {
        style: {},
        appendChild: (child) => {
          textarea.parentElement.child = child;
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = {
      querySelectorAll: () => [textarea]
    };

    textarea.parentElement.children = [];
    textarea.parentElement.appendChild = (child) => {
      textarea.parentElement.children.push(child);
      child.parentElement = textarea.parentElement;
    };

    setupTextareaMaximizer(container);

    assert.strictEqual(textarea.dataset.maximizerSetup, 'true');
    assert.strictEqual(textarea.parentElement.children.length, 2, 'Two buttons should be added (maximize and save)');
    assert.strictEqual(textarea.parentElement.children[0].className, 'textarea-maximize-btn');
    assert.strictEqual(textarea.parentElement.children[1].className, 'textarea-save-btn');
  });

  test('should toggle maximized state on button click', () => {
    let maximized = false;
    const textarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: (c) => {
          maximized = !maximized;
          return maximized;
        },
        add: () => {},
        contains: (c) => maximized
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: () => {},
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = {
      querySelectorAll: () => [textarea]
    };

    setupTextareaMaximizer(container);

    const btn = textarea.parentElement.children[0];
    const saveBtn = textarea.parentElement.children[1];
    
    btn.listeners.click({ preventDefault: () => {}, stopPropagation: () => {} });

    assert.strictEqual(maximized, true, 'Textarea should be maximized');
    assert.strictEqual(btn.title, 'Minimize');
    assert.ok(saveBtn.classList.has('is-maximized'), 'Save button should be marked as maximized');

    btn.listeners.click({ preventDefault: () => {}, stopPropagation: () => {} });
    assert.strictEqual(maximized, false, 'Textarea should be minimized');
    assert.strictEqual(btn.title, 'Maximize');
    assert.ok(!saveBtn.classList.has('is-maximized'), 'Save button should not be marked as maximized');
  });

  test('should dispatch save event on save button click', () => {
    const events = [];
    const textarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: () => {},
        add: () => {},
        contains: () => false
      },
      addEventListener: () => {},
      dispatchEvent: (e) => events.push(e),
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = {
      querySelectorAll: () => [textarea]
    };

    setupTextareaMaximizer(container);

    const saveBtn = textarea.parentElement.children[1];
    saveBtn.listeners.click({ preventDefault: () => {}, stopPropagation: () => {} });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'textarea:save');
    assert.strictEqual(events[0].bubbles, true);
  });

  test('should dispatch save event on Ctrl+S', () => {
    const events = [];
    const textarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: () => {},
        add: () => {},
        contains: () => false
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: (e) => events.push(e),
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = {
      querySelectorAll: () => [textarea]
    };

    setupTextareaMaximizer(container);

    textarea.listeners.keydown({ 
      ctrlKey: true, 
      key: 's', 
      preventDefault: () => {} 
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'textarea:save');
  });
});
