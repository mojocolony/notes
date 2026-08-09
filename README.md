# Notes

A small Markdown-first browser notes app designed for quick capture, organization, and portable files.

## Features

- Fast local autosave plus an IndexedDB recovery copy
- Editable titles with automatic first-line fallback
- Folders, tags, tag groups, pinning, Archive, and Trash
- Global search
- Manual or automatic sorting
- Live-styled Markdown editor and rendered Preview
- Smart checklists, bullets, and numbered lists
- Reorder mode for paragraphs and individual list items
- Image attachments
- Local version history with restore and restore-as-copy
- Backup export/import
- Optional Dropbox sync using real `.md` files
- Installable as a PWA when hosted over HTTPS

## GitHub Pages

Upload the project files to the root of a public GitHub repository and enable Pages from the `main` branch and `/ (root)` folder.

## Dropbox sync

Notes uses Dropbox OAuth 2 with PKCE, so no Dropbox app secret is placed in the website.

1. In the Dropbox App Console, use a Scoped App with **App folder** access.
2. Enable `files.content.read` and `files.content.write`.
3. Open Notes → Settings and copy the Redirect URI shown there.
4. Add that exact Redirect URI under the Dropbox app's OAuth 2 Redirect URIs.
5. Paste the Dropbox App Key into Notes and choose **Connect Dropbox**.

Notes stores its Dropbox data beneath `/Notes` in the app's private Dropbox app folder. Individual notes are saved as Markdown files. A small `.notes-index.json` file keeps note IDs, organization, and sync metadata aligned across devices. Image attachments are stored in matching `.assets` folders beside their note files.

Dropbox tokens are stored locally in each browser, so do not connect Dropbox on a public or shared computer.


## Nested folders
Folders can be dragged onto other folders to create subfolders. Drag a subfolder back to the top-level folder area to unnest it. Nested folder structure syncs through Dropbox, and Markdown files follow the same folder hierarchy.


## Web clipper bookmarklet

Open **Settings → Web Clipper** in the hosted app and drag **Save to Notes** to the browser bookmarks bar. When used on a webpage, it opens Notes with the page title, URL, and any selected text. You can create a new note or append/prepend the clip to an existing note.
