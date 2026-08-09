# Notes

A lightweight browser notes app with live-styled Markdown, folders, tags, search, pinning, archiving, image attachments, sharing/export, and touch-friendly block reordering.

## Live Markdown
The editor always stores real Markdown text, but styles it while you write. Headings appear at heading size, bold and italic are styled, links and quotes are visually distinct, and Markdown punctuation is kept faintly visible so the underlying file remains transparent and portable. The Preview button still gives you a completely rendered reading view.
 Links are actionable in both places: in the live editor, tap the small ↗ beside a link (or Cmd/Ctrl-click the link text on desktop); in Preview, click or tap the link normally.

## Local prototype
Open `index.html` in a modern browser. Notes are currently stored in that browser. Image attachments are stored locally in IndexedDB.

## Keyboard shortcuts
- `Q`: new note (when you are not already typing)
- `Cmd/Ctrl + N`: new note
- `Cmd/Ctrl + B`: bold
- `Cmd/Ctrl + I`: italic

## Export
Download produces an ordinary `.md` file. Notes with images download as a ZIP containing the Markdown file and an `attachments` folder.

Dropbox-backed Markdown files can be added after the editing workflow is finalized.


## Checklists

Use the checkbox toolbar button to turn a line into a Markdown task. In the live editor, task boxes are clickable. Press Return at the end of a checklist item to create the next unchecked item automatically; press Return on an empty checklist item to leave the checklist.

- Smart Return behavior continues checklists, bulleted lists, and numbered lists; Return on an empty item ends the list.


Notes can be dragged by their grab handle between folders or back to Inbox.

- Reorder mode treats checklist, bullet, and numbered-list items as individual draggable lines.


## Build 11 fixes
- Reorder mode treats every Markdown list item as its own draggable row.
- Dragging notes to Inbox/folders no longer leaves a note card inside the sidebar.
- Core app files use network-first caching and versioned URLs to prevent stale updates.


### v12 fix
Reorder mode now serializes real line breaks, keeps each Markdown list item as its own draggable row, and automatically repairs notes affected by the brief v11 literal `\\n` newline bug.


## Writing appearance
Use the **Aa** button in the Markdown toolbar to choose the note font and text size. The preference is stored locally and applies to both the live Markdown editor and Preview.

## Sorting notes
Each view and folder has its own saved sort choice. Notes can be ordered by modified date, created date, title, or manually. In **Manual** mode, drag a note by its handle to reposition it within the current list; the same handle can still be used to move the note into another folder or back to Inbox. Manual reordering is disabled while a search filter is active so a filtered result cannot accidentally overwrite the full folder order.

## Local safety and version history (v18)
Notes now saves the app state in two local browser stores: the immediate local save plus an IndexedDB recovery mirror. On startup, if the primary local save is missing, damaged, or older than the recovery copy, Notes restores the newer recovery copy automatically. Where supported, the app also requests persistent browser storage to reduce the chance of automatic eviction.

Use the **◴ History** button on a note to see automatic snapshots. Notes creates a snapshot after a short pause in editing, deduplicates unchanged versions, and keeps up to 100 local versions per note. You can save a version manually, preview an older version, restore it, or restore it as a separate copy. Restoring over the current note first saves a “Before restore” version.

Delete is now a two-step safety flow. The first delete moves a note to **Trash**. From Trash, **↩** restores it. Permanent deletion requires a confirmation and removes the note, its local images, and its local history.

**Export backup** now creates a full ZIP when JSZip is available. It contains the app state, local version history, and image attachments. Older JSON backups can still be imported.

These protections are all local to the browser/device. They substantially reduce accidental loss, but they are not a substitute for an external copy. Dropbox-backed real Markdown files are the next storage layer to add for protection against loss of browser/site data or the device itself.


## Tag organization
Tags can be sorted A–Z or manually. Create collapsible tag groups from the sidebar or Manage Tags, then drag tags between groups in Manual mode. Groups can be renamed or deleted without deleting the tags themselves.
