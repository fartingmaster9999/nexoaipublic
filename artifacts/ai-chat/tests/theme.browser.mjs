import assert from 'node:assert/strict';
import { withFixture, waitFor } from './browser-harness.mjs';

const themes = ['midnight', 'graphite', 'abyss', 'paper', 'dune'];

await withFixture('tests/theme.html', async ({ cdp, evaluate, navigate }) => {
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="dialog-settings"]') && !!document.querySelector('.cm-content')`), 'theme fixture and code editor');
  assert.ok(await evaluate(`!!document.querySelector('[data-testid="input-groq-api-key"]')`), 'API Keys menu is the initial settings view');
  await evaluate(`document.querySelector('[data-testid="settings-nav-appearance"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="theme-midnight"]') && !document.querySelector('[data-testid="input-groq-api-key"]')`), 'appearance view is separate from provider key inputs');
  await evaluate(`document.querySelector('[data-testid="settings-nav-api"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="input-groq-api-key"]') && !document.querySelector('[data-testid="theme-midnight"]')`), 'API Keys view is separate from appearance controls');
  await evaluate(`document.querySelector('[data-testid="settings-nav-appearance"]').click()`);

  const readModeAccessibility = async (name) => {
    const { nodes } = await cdp('Accessibility.getFullAXTree');
    const node = nodes.find((entry) => entry.role?.value === 'button' && entry.name?.value === name);
    assert.ok(node, `Accessibility tree contains the ${name} button`);
    const property = (name) => node.properties?.find((entry) => entry.name === name)?.value?.value ?? null;
    return {
      role: node.role?.value,
      name: node.name?.value,
      description: node.description?.value,
      pressed: property('pressed') === 'true',
    };
  };
  const assertModeAccessibility = async (name, pressed, descriptionPattern) => {
    const state = await readModeAccessibility(name);
    assert.deepEqual(
      { role: state.role, name: state.name, pressed: state.pressed },
      { role: 'button', name, pressed },
      `${name} is exposed as a named toggle with the correct pressed state`,
    );
    assert.match(state.description ?? '', descriptionPattern, `${name} description explains its state and effect`);
  };

  await evaluate(`document.querySelector('[data-testid="button-close-settings"]').click()`);
  await evaluate(`document.querySelector('[data-testid="button-close-workspace"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="dialog-settings"]') && !document.querySelector('.workspace')`), 'close modal layers before mode accessibility checks');

  await assertModeAccessibility('Deepthink', false, /Off.*deeper reasoning.*next message/);
  await assertModeAccessibility('Agent', false, /Off.*(?:Agent.*next message|next message.*Agent).*research.*build-and-test/);
  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed') === 'true'`), 'Deepthink selected for accessibility check');
  await assertModeAccessibility('Deepthink', true, /On.*deeper reasoning.*next message/);
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed') === 'true'`), 'Agent selected for accessibility check');
  await assertModeAccessibility('Agent', true, /On.*(?:Agent.*next message|next message.*Agent).*research.*build-and-test/);
  await evaluate(`document.querySelector('[data-testid="simulate-streaming"]').click()`);
  const streamingDescriptions = await Promise.all([
    readModeAccessibility('Deepthink'),
    readModeAccessibility('Agent'),
  ]);
  assert.match(streamingDescriptions[0].description ?? '', /Changes apply to your next message; this reply keeps its original mode/,
    'Deepthink description preserves the next-message boundary during a reply');
  assert.match(streamingDescriptions[1].description ?? '', /Changes apply to your next message; this reply keeps its original route/,
    'Agent description preserves the next-message boundary during a reply');
  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed') === 'false'`), 'Deepthink unselected for accessibility check');
  await assertModeAccessibility('Deepthink', false, /Off.*deeper reasoning.*next message.*Changes apply to your next message/);
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed') === 'false'`), 'Agent unselected for accessibility check');
  await assertModeAccessibility('Agent', false, /Off.*next message.*Agent.*research.*build-and-test.*Changes apply to your next message/);
  await evaluate(`document.querySelector('[data-testid="simulate-streaming"]').click()`);
  console.log('Mode accessibility checks passed: named pressed states and descriptions update after toggles, including during a reply.');
  await evaluate(`document.querySelector('.top-btn').click()`);
  await evaluate(`document.querySelector('[data-testid="reopen-workspace-fixture"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="dialog-settings"]') && !!document.querySelector('.cm-content')`), 'reopen modal layers after mode accessibility checks');

  const readContrast = (selector, foregroundProperty, backgroundSelector, pseudo = '') => evaluate(`(() => {
    const parse = (text) => {
      const channels = text.match(/[\\d.]+/g)?.map(Number) ?? [];
      return channels.length >= 3 ? channels.slice(0, 3) : null;
    };
    const linear = (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
    const foreground = parse(getComputedStyle(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(pseudo)})[${JSON.stringify(foregroundProperty)}]);
    const background = parse(getComputedStyle(document.querySelector(${JSON.stringify(backgroundSelector)})).backgroundColor);
    if (!foreground || !background) return null;
    const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return Number(((high + 0.05) / (low + 0.05)).toFixed(2));
  })()`);

  for (const theme of themes) {
    if (!await evaluate(`!!document.querySelector('[data-testid="dialog-settings"]')`)) {
      await evaluate(`document.querySelector('.top-btn').click()`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-testid="dialog-settings"]')`), 'appearance dialog reopen');
    }
    await evaluate(`document.querySelector('[data-testid="theme-${theme}"]').click()`);
    await waitFor(() => evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), `${theme} theme selection`);
    await evaluate(`document.querySelector('[data-testid="button-close-settings"]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="dialog-settings"]')`), `${theme} appearance dialog close`);

    const checks = [
      ['home description', await readContrast('.landing-intro', 'color', 'body'), 4.5],
      ['home wordmark', await readContrast('.landing-wordmark', 'color', 'body'), 4.5],
      ['sidebar section label', await readContrast('.thread-heading', 'color', '.sidebar'), 4.5],
      ['sidebar recent conversation', await readContrast('.thread-select', 'color', '.sidebar'), 4.5],
      ['sidebar inactive conversation', await readContrast('.thread-select:not(.is-active)', 'color', '.sidebar'), 4.5],
      ['sidebar appearance control', await readContrast('.sidebar-settings', 'color', '.sidebar'), 4.5],
      ['composer placeholder', await readContrast('.composer textarea', 'color', '.composer-wrap', '::placeholder'), 4.5],
      ['home primary button', await readContrast('.landing-primary', 'color', '.landing-primary'), 4.5],
      ['workspace run button', await readContrast('.ws-btn.run', 'color', '.ws-btn.run'), 4.5],
      ['workspace console text', await readContrast('.ws-console', 'color', '.ws-console'), 4.5],
      ['workspace console status', await readContrast('.c-status', 'color', '.ws-console'), 4.5],
      ['code editor text', await readContrast('.cm-content', 'color', '.cm-editor'), 4.5],
    ];
    for (const [label, ratio, minimum] of checks) {
      assert.ok(ratio >= minimum, `${theme}: ${label} contrast ${ratio}:1 is below ${minimum}:1`);
    }

    const borders = await evaluate(`(() => {
      const ratio = (a, b) => {
        const lum = (value) => {
          const c = value.match(/[\\d.]+/g).map(Number).slice(0, 3).map((n) => {
            const v = n / 255;
            return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
          });
          return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
        };
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + .05) / (lo + .05);
      };
      const sidebar = getComputedStyle(document.querySelector('.sidebar'));
      const composer = getComputedStyle(document.querySelector('.composer-wrap'));
      return {
        sidebar: ratio(sidebar.borderRightColor, sidebar.backgroundColor),
        composer: ratio(composer.borderTopColor, composer.backgroundColor),
        topbar: ratio(getComputedStyle(document.querySelector('.topbar')).borderBottomColor, getComputedStyle(document.querySelector('.topbar')).backgroundColor),
        workspace: ratio(getComputedStyle(document.querySelector('.workspace')).borderLeftColor, getComputedStyle(document.querySelector('.workspace')).backgroundColor),
        language: ratio(getComputedStyle(document.querySelector('.ws-select')).borderColor, getComputedStyle(document.querySelector('.ws-select')).backgroundColor),
      };
    })()`);
    assert.ok(borders.sidebar >= 1.2, `${theme}: sidebar edge should remain visible (${borders.sidebar}:1)`);
    assert.ok(borders.composer >= 1.2, `${theme}: composer edge should remain visible (${borders.composer}:1)`);
    assert.ok(borders.topbar >= 1.2, `${theme}: topbar separator should remain visible (${borders.topbar}:1)`);
    assert.ok(borders.workspace >= 1.2, `${theme}: workspace edge should remain visible (${borders.workspace}:1)`);
    assert.ok(borders.language >= 1.2, `${theme}: workspace control border should remain visible (${borders.language}:1)`);

    await evaluate(`document.querySelector('.composer textarea').focus()`);
    const focus = await evaluate(`(() => {
      const wrap = document.querySelector('.composer-wrap');
      return { within: wrap.matches(':focus-within'), border: getComputedStyle(wrap).borderTopColor,
        accent: getComputedStyle(document.querySelector('.landing-primary')).backgroundColor,
        boxShadow: getComputedStyle(wrap).boxShadow };
    })()`);
    assert.equal(focus.within, true, `${theme}: composer should enter its focused state`);
    assert.match(focus.boxShadow, /rgba?\(/, `${theme}: composer focus ring should be visible`);
    assert.deepEqual(focus.border.match(/\d+/g)?.slice(0, 3), focus.accent.match(/\d+/g)?.slice(0, 3),
      `${theme}: focused composer border should use the theme accent`);
    const composerFocusContrast = await readContrast('.composer-wrap', 'borderTopColor', '.composer-wrap');
    assert.ok(composerFocusContrast >= 3, `${theme}: focused composer border contrast ${composerFocusContrast}:1 is below 3:1`);

    for (const selector of ['.image-attach-button', '[data-testid="toggle-deepthink"]', '[data-testid="toggle-agent"]', '.send-button']) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert.equal(await evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`), true,
        `${theme}: keyboard Tab reaches ${selector} in composer order`);
    }
    const outline = await evaluate(`(() => {
      const button = document.activeElement;
      const style = getComputedStyle(button);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    })()`);
    assert.ok(Number.parseFloat(outline.width) >= 2, `${theme}: keyboard focus outline should be at least 2px`);
    assert.equal(outline.style, 'solid', `${theme}: keyboard focus outline style`);
    const focusContrast = await readContrast('.send-button', 'outlineColor', '.composer-wrap');
    assert.ok(focusContrast >= 3, `${theme}: keyboard focus outline contrast ${focusContrast}:1 is below 3:1`);
  }

  assert.equal(await evaluate(`localStorage.getItem('nexo-theme-v1') !== null`), true, 'Selected theme is persisted');
  await evaluate(`document.querySelector('.top-btn').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="dialog-settings"]')`), 'appearance dialog for selected state');
  assert.deepEqual(await evaluate(`document.querySelectorAll('[role="radio"][aria-checked="true"]').length`), 2, 'One theme and one accent remain selected');

  const remoteAppearance = JSON.stringify({ theme: 'abyss', accent: 'rose' });
  await evaluate(`(() => {
    localStorage.setItem('nexo-theme-v1', ${JSON.stringify(remoteAppearance)});
    const originalSetItem = Storage.prototype.setItem;
    window.__themeStorageWrites = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'nexo-theme-v1') window.__themeStorageWrites++;
      return originalSetItem.call(this, key, value);
    };
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'nexo-theme-v1', newValue: ${JSON.stringify(remoteAppearance)}, storageArea: localStorage
    }));
  })()`);
  await waitFor(() => evaluate(`document.documentElement.dataset.theme === 'abyss'`), 'appearance update from another tab');
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`), '346 78% 60%', 'Remote accent is applied');
  assert.equal(await evaluate(`window.__themeStorageWrites`), 0, 'Remote appearance changes do not write back to storage');

  await navigate();
  await waitFor(() => evaluate(`document.documentElement.dataset.theme === 'abyss'`), 'appearance remains selected after reload');
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('nexo-theme-v1'))`), { theme: 'abyss', accent: 'rose' }, 'Remote appearance remains saved after reload');

  await cdp('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'forced-colors', value: 'active' },
    ],
  });
  assert.equal(await evaluate(`matchMedia('(forced-colors: active)').matches`), true, 'Chromium emulates forced-colors mode');
  const forcedColorSurfaces = await evaluate(`(() => {
    const selectors = ['.home-landing', '.sidebar', '.composer-wrap', '.workspace', '.ws-editor', '.ws-console'];
    return Object.fromEntries(selectors.map((selector) => {
      const element = document.querySelector(selector);
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return [selector, {
        visible: style.display !== 'none' && rect.width > 0 && rect.height > 0,
        color: style.color,
        background: style.backgroundColor,
        forcedColorAdjust: style.forcedColorAdjust,
      }];
    }));
  })()`);
  for (const [surface, style] of Object.entries(forcedColorSurfaces)) {
    assert.equal(style.visible, true, `Forced colors: ${surface} remains visible`);
    assert.notEqual(style.color, 'rgba(0, 0, 0, 0)', `Forced colors: ${surface} has readable text color`);
    assert.equal(style.forcedColorAdjust, 'auto', `Forced colors: ${surface} keeps system color adjustment enabled`);
    const contrast = await readContrast(surface, 'color', surface);
    assert.ok(contrast >= 4.5, `Forced colors: ${surface} text contrast ${contrast}:1 is below 4.5:1`);
  }
  const forcedControls = await evaluate(`(() => {
    const selectors = ['.landing-primary', '.sidebar-settings', '.composer textarea', '.ws-select', '.ws-btn.run'];
    return Object.fromEntries(selectors.map((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return [selector, { color: style.color, background: style.backgroundColor }];
    }));
  })()`);
  for (const [control, style] of Object.entries(forcedControls)) {
    assert.notEqual(style.color, 'rgba(0, 0, 0, 0)', `Forced colors: ${control} retains text`);
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)', `Forced colors: ${control} retains its fallback surface`);
  }
  for (const [control, background] of [
    ['.landing-primary', '.landing-primary'],
    ['.sidebar-settings', '.sidebar'],
    ['.composer textarea', '.composer textarea'],
    ['.ws-select', '.ws-select'],
    ['.ws-btn.run', '.ws-btn.run'],
  ]) {
    const contrast = await readContrast(control, 'color', background);
    assert.ok(contrast >= 4.5, `Forced colors: ${control} text contrast ${contrast}:1 is below 4.5:1`);
  }

  // A narrower CSS viewport reproduces the reflow users see at 200% desktop zoom.
  if (await evaluate(`!!document.querySelector('[data-testid="dialog-settings"]')`)) {
    await evaluate(`document.querySelector('[data-testid="button-close-settings"]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="dialog-settings"]')`), 'close appearance dialog before zoomed composer checks');
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 720, height: 640, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate(`document.querySelector('.ws-btn.run')?.getBoundingClientRect().width > 0`), 'workspace controls at zoomed viewport');
  await evaluate(`document.querySelector('.ws-select').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate(`document.activeElement.matches('.ws-btn.wrap-toggle')`), true, 'Keyboard Tab reaches the line-wrap control before Run');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const zoomedFocus = await evaluate(`(() => {
    const button = document.activeElement;
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return {
      isRunButton: button.matches('.ws-btn.run'),
      visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
      focusVisible: button.matches(':focus-visible'),
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
    };
  })()`);
  assert.equal(zoomedFocus.isRunButton, true, 'Keyboard Tab reaches the workspace run control at zoomed viewport width');
  assert.equal(zoomedFocus.visible, true, 'The focused workspace control remains inside the zoomed viewport');
  assert.equal(zoomedFocus.focusVisible, true, 'Keyboard focus remains visibly indicated at zoomed viewport width');
  assert.ok(Number.parseFloat(zoomedFocus.outlineWidth) >= 2, 'Zoomed keyboard focus outline is at least 2 CSS pixels');
  assert.equal(zoomedFocus.outlineStyle, 'solid', 'Zoomed keyboard focus outline remains solid');
  const forcedFocusContrast = await readContrast('.ws-btn.run', 'outlineColor', '.ws-btn.run');
  assert.ok(forcedFocusContrast >= 3, `Forced colors: zoomed focus outline contrast ${forcedFocusContrast}:1 is below 3:1`);
  await evaluate(`document.querySelector('[data-testid="button-close-workspace"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('.workspace')`), 'close workspace before zoomed composer checks');

  const zoomedModes = await evaluate(`(() => {
    const group = document.querySelector('.composer-mode-buttons');
    const buttons = [...group.querySelectorAll('.mode-toggle')];
    const rect = (element) => {
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    return {
      groupName: group.getAttribute('aria-label'),
      labels: buttons.map((button) => button.innerText.trim()),
      visible: buttons.map((button) => {
        const bounds = rect(button);
        return bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
          bounds.left >= 0 && bounds.right <= innerWidth && getComputedStyle(button).visibility === 'visible';
      }),
      overlap: buttons.length === 2 && (() => {
        const [first, second] = buttons.map(rect);
        return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
      })(),
      states: buttons.map((button) => ({
        pressed: button.getAttribute('aria-pressed'),
        label: button.getAttribute('aria-label'),
        description: button.getAttribute('aria-description'),
        tooltip: button.getAttribute('title'),
        color: getComputedStyle(button).color,
        background: getComputedStyle(button).backgroundColor,
        border: getComputedStyle(button).borderColor,
      })),
    };
  })()`);
  assert.equal(zoomedModes.groupName, 'Message modes', 'Mode controls have an accessible group name at 200% zoom');
  assert.deepEqual(zoomedModes.labels, ['Deepthink', 'Agent'], 'Both mode labels remain distinct at 200% zoom');
  assert.deepEqual(zoomedModes.visible, [true, true], 'Both mode controls remain within the viewport at 200% zoom');
  assert.equal(zoomedModes.overlap, false, 'Mode controls do not overlap at 200% zoom');
  assert.deepEqual(zoomedModes.states.map(({ pressed }) => pressed), ['false', 'false'], 'Both controls start unselected');
  for (const state of zoomedModes.states) {
    assert.ok(state.label, 'Each mode control keeps its accessible name');
    assert.ok(state.description, `${state.label}: accessible mode description remains available`);
    assert.ok(state.tooltip, `${state.label}: tooltip text remains available`);
  }
  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed') === 'true'`), 'Deepthink selected state at zoomed viewport');
  const selectedDeepthink = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="toggle-deepthink"]');
    const style = getComputedStyle(button);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor };
  })()`);
  assert.notDeepEqual(selectedDeepthink, {
    color: zoomedModes.states[0].color,
    background: zoomedModes.states[0].background,
    border: zoomedModes.states[0].border,
  }, 'Selected Deepthink styling differs from its unselected style');
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed') === 'true'`), 'Agent selected state at zoomed viewport');
  const selectedAgent = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="toggle-agent"]');
    const style = getComputedStyle(button);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor };
  })()`);
  assert.notDeepEqual(selectedAgent, {
    color: zoomedModes.states[1].color,
    background: zoomedModes.states[1].background,
    border: zoomedModes.states[1].border,
  }, 'Selected Agent styling differs from its unselected style');

  await evaluate(`document.querySelector('.composer textarea').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const firstComposerTab = await evaluate(`(() => {
    const active = document.activeElement;
    return { tag: active.tagName, label: active.getAttribute('aria-label'), testId: active.getAttribute('data-testid'), className: active.className };
  })()`);
  assert.equal(firstComposerTab.className.includes('image-attach-button'), true,
    `Keyboard Tab reaches the composer image control first (${JSON.stringify(firstComposerTab)})`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const zoomedModeFocus = await evaluate(`(() => {
    const button = document.activeElement;
    const style = getComputedStyle(button);
    const bounds = button.getBoundingClientRect();
    return {
      isDeepthink: button.matches('[data-testid="toggle-deepthink"]'),
      visible: bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
        bounds.left >= 0 && bounds.right <= innerWidth,
      focusVisible: button.matches(':focus-visible'),
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      description: button.getAttribute('aria-description'),
      tooltip: button.getAttribute('title'),
    };
  })()`);
  assert.equal(zoomedModeFocus.isDeepthink, true, 'Keyboard Tab reaches Deepthink at 200% zoom');
  assert.equal(zoomedModeFocus.visible, true, 'Focused Deepthink remains fully visible at 200% zoom');
  assert.equal(zoomedModeFocus.focusVisible, true, 'Deepthink keyboard focus remains visibly indicated at 200% zoom');
  assert.ok(Number.parseFloat(zoomedModeFocus.outlineWidth) >= 2, 'Mode focus outline remains at least 2 CSS pixels');
  assert.equal(zoomedModeFocus.outlineStyle, 'solid', 'Mode focus outline remains solid');
  assert.ok(zoomedModeFocus.description && zoomedModeFocus.tooltip, 'Mode description and tooltip remain available while focused');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate(`document.activeElement.matches('[data-testid="toggle-agent"]')`), true, 'Keyboard Tab reaches Agent after Deepthink at 200% zoom');
  const agentFocus = await evaluate(`(() => {
    const button = document.activeElement;
    const bounds = button.getBoundingClientRect();
    return { visible: bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
        bounds.left >= 0 && bounds.right <= innerWidth,
      focusVisible: button.matches(':focus-visible'), description: button.getAttribute('aria-description'), tooltip: button.getAttribute('title') };
  })()`);
  assert.equal(agentFocus.visible, true, 'Focused Agent remains fully visible at 200% zoom');
  assert.equal(agentFocus.focusVisible, true, 'Agent keyboard focus remains visible at 200% zoom');
  assert.ok(agentFocus.description && agentFocus.tooltip, 'Agent description and tooltip remain available while focused');

  // A 360 CSS-pixel desktop viewport reproduces the narrow layout at 400% zoom.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]')?.getBoundingClientRect().width > 0`), 'mode controls at 400% zoom');
  const modesAt400 = await evaluate(`(() => {
    const group = document.querySelector('.composer-mode-buttons');
    const buttons = [...group.querySelectorAll('.mode-toggle')];
    const rects = buttons.map((button) => button.getBoundingClientRect());
    return {
      groupName: group.getAttribute('aria-label'),
      labels: buttons.map((button) => button.innerText.trim()),
      names: buttons.map((button) => button.getAttribute('aria-label')),
      visible: rects.map((rect, i) => rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight &&
        rect.left >= 0 && rect.right <= innerWidth && getComputedStyle(buttons[i]).visibility === 'visible'),
      overlap: rects[0].left < rects[1].right && rects[0].right > rects[1].left &&
        rects[0].top < rects[1].bottom && rects[0].bottom > rects[1].top,
    };
  })()`);
  assert.equal(modesAt400.groupName, 'Message modes', 'Mode controls retain their accessible group name at 400% zoom');
  assert.deepEqual(modesAt400.labels, ['Deepthink', 'Agent'], 'Deepthink and Agent remain separately identifiable at 400% zoom');
  assert.deepEqual(modesAt400.names, ['Deepthink', 'Agent'], 'Both accessible control names remain distinct at 400% zoom');
  assert.deepEqual(modesAt400.visible, [true, true], 'Both mode controls remain within the viewport at 400% zoom');
  assert.equal(modesAt400.overlap, false, 'Mode controls do not overlap at 400% zoom');

  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed') === 'false'`), 'Deepthink unselected at 400% zoom');
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed') === 'false'`), 'Agent unselected at 400% zoom');
  const unselectedAt400 = await evaluate(`['toggle-deepthink', 'toggle-agent'].map((id) => {
    const style = getComputedStyle(document.querySelector('[data-testid="' + id + '"]'));
    return [style.color, style.backgroundColor, style.borderColor];
  })`);
  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed') === 'true'`), 'Deepthink selected at 400% zoom');
  const selectedDeepthinkAt400 = await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('[data-testid="toggle-deepthink"]'));
    return [style.color, style.backgroundColor, style.borderColor];
  })()`);
  assert.notDeepEqual(selectedDeepthinkAt400, unselectedAt400[0], 'Deepthink selected styling differs from unselected at 400% zoom');
  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed') === 'true'`), 'Agent selected at 400% zoom');
  const selectedAgentAt400 = await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('[data-testid="toggle-agent"]'));
    return [style.color, style.backgroundColor, style.borderColor];
  })()`);
  assert.notDeepEqual(selectedAgentAt400, unselectedAt400[1], 'Agent selected styling differs from unselected at 400% zoom');

  const readModeFocusAt400 = (testId) => evaluate(`(() => {
    const button = document.activeElement;
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const inset = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const focus = { left: bounds.left - inset, right: bounds.right + inset, top: bounds.top - inset, bottom: bounds.bottom + inset };
    let clippedByAncestor = false;
    for (let parent = button.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      const parentBounds = parent.getBoundingClientRect();
      const left = parentBounds.left + parent.clientLeft;
      const top = parentBounds.top + parent.clientTop;
      const right = left + parent.clientWidth;
      const bottom = top + parent.clientHeight;
      const clipX = ['hidden', 'clip', 'auto', 'scroll'].includes(parentStyle.overflowX);
      const clipY = ['hidden', 'clip', 'auto', 'scroll'].includes(parentStyle.overflowY);
      if ((clipX && (focus.left < left || focus.right > right)) || (clipY && (focus.top < top || focus.bottom > bottom))) {
        clippedByAncestor = true;
        break;
      }
    }
    return {
      expected: button.matches('[data-testid="' + ${JSON.stringify(testId)} + '"]'),
      focusVisible: button.matches(':focus-visible'),
      insideViewport: focus.left >= 0 && focus.top >= 0 && focus.right <= innerWidth && focus.bottom <= innerHeight,
      clippedByAncestor,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      description: button.getAttribute('aria-description'),
      tooltip: button.getAttribute('title'),
    };
  })()`);

  await evaluate(`document.querySelector('.composer textarea').focus()`);
  for (let i = 0; i < 2; i++) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  }
  const deepthinkFocusAt400 = await readModeFocusAt400('toggle-deepthink');
  assert.equal(deepthinkFocusAt400.expected, true, 'Keyboard Tab reaches Deepthink at 400% zoom');
  assert.equal(deepthinkFocusAt400.focusVisible, true, 'Deepthink has visible keyboard focus at 400% zoom');
  assert.equal(deepthinkFocusAt400.insideViewport, true, 'Deepthink focus outline remains inside the 400% viewport');
  assert.equal(deepthinkFocusAt400.clippedByAncestor, false, 'Deepthink focus outline is not clipped at 400% zoom');
  assert.ok(Number.parseFloat(deepthinkFocusAt400.outlineWidth) >= 2, 'Deepthink focus outline remains at least 2 CSS pixels');
  assert.equal(deepthinkFocusAt400.outlineStyle, 'solid', 'Deepthink focus outline remains solid');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const agentFocusAt400 = await readModeFocusAt400('toggle-agent');
  assert.equal(agentFocusAt400.expected, true, 'Keyboard Tab reaches Agent after Deepthink at 400% zoom');
  assert.equal(agentFocusAt400.focusVisible, true, 'Agent has visible keyboard focus at 400% zoom');
  assert.equal(agentFocusAt400.insideViewport, true, 'Agent focus outline remains inside the 400% viewport');
  assert.equal(agentFocusAt400.clippedByAncestor, false, 'Agent focus outline is not clipped at 400% zoom');
  assert.ok(agentFocusAt400.description && agentFocusAt400.tooltip, 'Agent description and tooltip remain available at 400% zoom');

});
