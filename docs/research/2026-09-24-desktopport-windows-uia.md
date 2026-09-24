# DesktopPort Windows UI Automation upstream recheck — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE INPUT / SOURCE-ONLY

## UI Automation tree and control view

Microsoft UI Automation exposes application UI as a tree of AutomationElement objects. The Control
View is the subset that closely maps to the UI structure perceived by the user and is explicitly
useful for automated testing. Microsoft also warns that walking a large UI Automation tree is
resource-intensive and recommends FindFirst/FindAll/cache-oriented retrieval when possible.

Official sources:
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-obtainingelements
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usefortesting

Disposition:
- DesktopPort snapshots should be based on Control View semantics by default;
- the future native backend should prefer targeted lookup/cache over unconditional raw-tree walks;
- element refs are snapshot-scoped and must not be replayed after UI mutation.

## Control patterns

Microsoft UI Automation control patterns expose semantic capabilities independent of visual
appearance. Invoke is for unambiguous stateless actions; stateful controls use patterns such as
Toggle and Selection, while Value represents editable/control values.

Official sources:
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementinginvoke

Disposition:
- DesktopPort v1 exposes Invoke / Value / Toggle / SelectionItem;
- unsupported patterns fail before backend effect;
- raw mouse coordinates are not a v1 primitive.

## Visual observation

Windows.Graphics.Capture provides frame capture from a display or application window and can be
used for video or screenshots.

Official source:
- https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture

Disposition:
- screenshot remains a separate observation primitive;
- UI Automation semantics remain primary;
- a Windows.Graphics.Capture backend is future work and is not claimed by this source slice.
