# Semantic Browser upstream evidence — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE RECHECK / SOURCE DESIGN INPUT

## Accessibility tree

Current Chrome DevTools Protocol exposes Accessibility.getFullAXTree and AXNode.backendDOMNodeId.
The backend DOM id is the bridge WAG needs to turn human-readable semantic observations into
server-owned element references without asking the model for screen coordinates.

Official source:
- https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/

Disposition:
- Browser Harness snapshots the accessibility tree;
- ignored or non-DOM-backed nodes are not made actionable;
- WAG mints opaque refs scoped to the latest snapshot;
- refs are invalidated by the next snapshot or navigation.

## DOM and input

Current CDP DOM exposes scrollIntoViewIfNeeded, getBoxModel and focus. The Input domain exposes
dispatchMouseEvent, dispatchKeyEvent and insertText.

Official sources:
- https://chromedevtools.github.io/devtools-protocol/tot/DOM/
- https://chromedevtools.github.io/devtools-protocol/tot/Input/

Disposition:
- semantic click resolves a WAG-owned ref to backendDOMNodeId, scrolls it into view, derives the
  center from the DOM box model and then sends pointer input;
- the caller/model never supplies raw x/y coordinates;
- fill focuses an editable semantic target, selects current text and uses Input.insertText;
- key input is an allowlist rather than arbitrary protocol parameters.

## Raw Runtime

CDP Runtime remains available below the adapter for future code-capable browser workers, but this
semantic slice does not expose Runtime.evaluate or callFunctionOn as a public action surface.

Official source:
- https://chromedevtools.github.io/devtools-protocol/tot/Runtime/

## Non-decision

This source evidence does not authorize live browser automation, public MCP browser tools, arbitrary
JavaScript execution, vision/pixel fallback, or adoption of stale refs after page state changes.
