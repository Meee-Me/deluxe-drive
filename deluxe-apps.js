/* Deluxe apps: the app switcher shared by every Deluxe site.
 *
 * The same file is copied into Deluxe Drive, Docs, Convert, Translate and
 * YouTube Guider AI (each site serves its own copy, so none depends on
 * another being up). Put <div data-deluxe-apps data-current="docs"></div>
 * where the button should go, or call DeluxeApps.open(anchor, { current }).
 * data-theme="dark" | "light" | "auto" (auto follows <html data-theme>,
 * then the system setting).
 *
 * Generated: edit the template and run the build, then copy to every site.
 */
(function () {
  'use strict';
  if (window.DeluxeApps) return;

  var APPS = [
      {
          "id": "drive",
          "name": "Deluxe Drive",
          "tag": "Your files",
          "url": "https://deluxe-drive-xi.vercel.app/",
          "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEZWx1eGUgRHJpdmUiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJ0aWxlIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmZmZmZiIgLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZWVmMWZmIiAvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iYmFuZDEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNjM2NmYxIiAvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM0MzM4Y2EiIC8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiYW5kMiIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMxNGI4YTYiIC8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzBkOTQ4OCIgLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJhbmQzIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZiYmYyNCIgLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIiAvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxmaWx0ZXIgaWQ9ImRyb3AiIHg9Ii0yMCUiIHk9Ii0yMCUiIHdpZHRoPSIxNDAlIiBoZWlnaHQ9IjE0MCUiPgogICAgICA8ZmVEcm9wU2hhZG93IGR4PSIwIiBkeT0iMTAiIHN0ZERldmlhdGlvbj0iMTIiIGZsb29kLWNvbG9yPSIjMzEyZTgxIiBmbG9vZC1vcGFjaXR5PSIwLjE4IiAvPgogICAgPC9maWx0ZXI+CiAgPC9kZWZzPgoKICA8cmVjdCB4PSIxNiIgeT0iMTYiIHdpZHRoPSI0ODAiIGhlaWdodD0iNDgwIiByeD0iMTEyIiBmaWxsPSJ1cmwoI3RpbGUpIiBzdHJva2U9IiNkZGUyZjUiIHN0cm9rZS13aWR0aD0iNCIgLz4KCiAgPGcgZmlsdGVyPSJ1cmwoI2Ryb3ApIiB0cmFuc2Zvcm09InNrZXdYKC0xMikiPgogICAgPHJlY3QgeD0iMTY5IiB5PSIxNDgiIHdpZHRoPSIyNTAiIGhlaWdodD0iNjIiIHJ4PSIzMSIgZmlsbD0idXJsKCNiYW5kMSkiIC8+CiAgICA8cmVjdCB4PSIyMDUiIHk9IjIyOCIgd2lkdGg9IjIxMiIgaGVpZ2h0PSI2MiIgcng9IjMxIiBmaWxsPSJ1cmwoI2JhbmQyKSIgLz4KICAgIDxyZWN0IHg9IjI0MSIgeT0iMzA4IiB3aWR0aD0iMTc0IiBoZWlnaHQ9IjYyIiByeD0iMzEiIGZpbGw9InVybCgjYmFuZDMpIiAvPgogIDwvZz4KPC9zdmc+Cg=="
      },
      {
          "id": "docs",
          "name": "Deluxe Docs",
          "tag": "Open documents",
          "url": "https://deluxe-docs-iota.vercel.app/",
          "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEZWx1eGUgRG9jcyI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InRpbGUiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmZmZmZmYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNFNkVFRkYiLz48L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJwYWdlIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjM0I4MkZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMTQ1MEQyIi8+PC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iYmFjayIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzdFQThGRiIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzNENkZFMCIvPjwvbGluZWFyR3JhZGllbnQ+CiAgICA8ZmlsdGVyIGlkPSJkcm9wIiB4PSItMjAlIiB5PSItMjAlIiB3aWR0aD0iMTQwJSIgaGVpZ2h0PSIxNDAlIj48ZmVEcm9wU2hhZG93IGR4PSIwIiBkeT0iMTAiIHN0ZERldmlhdGlvbj0iMTIiIGZsb29kLWNvbG9yPSIjMEIyQTZCIiBmbG9vZC1vcGFjaXR5PSIuMjIiLz48L2ZpbHRlcj4KICA8L2RlZnM+CiAgPHJlY3QgeD0iMTYiIHk9IjE2IiB3aWR0aD0iNDgwIiBoZWlnaHQ9IjQ4MCIgcng9IjExMiIgZmlsbD0idXJsKCN0aWxlKSIgc3Ryb2tlPSIjRDZFMkZBIiBzdHJva2Utd2lkdGg9IjQiLz4KICA8ZyBmaWx0ZXI9InVybCgjZHJvcCkiPgogICAgPHJlY3QgeD0iMTgyIiB5PSI5NiIgd2lkdGg9IjIxMCIgaGVpZ2h0PSIyNzAiIHJ4PSIyNiIgZmlsbD0idXJsKCNiYWNrKSIgdHJhbnNmb3JtPSJyb3RhdGUoMTAgMjg3IDIzMSkiLz4KICAgIDxyZWN0IHg9IjEyOCIgeT0iMTMyIiB3aWR0aD0iMjE0IiBoZWlnaHQ9IjI4MiIgcng9IjI2IiBmaWxsPSIjZmZmZmZmIiBzdHJva2U9IiNDOUQ4RjciIHN0cm9rZS13aWR0aD0iNCIvPgogIDwvZz4KICA8cGF0aCBkPSJNMTU0IDEzMmgxNjJhMjYgMjYgMCAwIDEgMjYgMjZ2MzZIMTI4di0zNmEyNiAyNiAwIDAgMSAyNi0yNnoiIGZpbGw9InVybCgjcGFnZSkiLz4KICA8cmVjdCB4PSIxNjAiIHk9IjIyNiIgd2lkdGg9IjE1MCIgaGVpZ2h0PSIxNiIgcng9IjgiIGZpbGw9IiNCN0M2RTYiLz4KICA8cmVjdCB4PSIxNTIiIHk9IjI1OCIgd2lkdGg9IjEyOCIgaGVpZ2h0PSIzMCIgcng9IjgiIGZpbGw9IiNGRkQ4NEQiIG9wYWNpdHk9Ii45Ii8+CiAgPHJlY3QgeD0iMTYwIiB5PSIyNjUiIHdpZHRoPSIxMTIiIGhlaWdodD0iMTYiIHJ4PSI4IiBmaWxsPSIjNUI2QjhDIi8+CiAgPHJlY3QgeD0iMTYwIiB5PSIzMDQiIHdpZHRoPSIxNTAiIGhlaWdodD0iMTYiIHJ4PSI4IiBmaWxsPSIjQjdDNkU2Ii8+CiAgPHJlY3QgeD0iMTYwIiB5PSIzNDAiIHdpZHRoPSI5NiIgaGVpZ2h0PSIxNiIgcng9IjgiIGZpbGw9IiNCN0M2RTYiLz4KPC9zdmc+Cg=="
      },
      {
          "id": "convert",
          "name": "Deluxe Convert",
          "tag": "Convert files",
          "url": "https://deluxe-convert.vercel.app/",
          "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEZWx1eGUgQ29udmVydCI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InRpbGUiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM3QzVDRkYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMzNUQ3RTgiLz48L2xpbmVhckdyYWRpZW50PgogICAgPGZpbHRlciBpZD0iZHJvcCIgeD0iLTIwJSIgeT0iLTIwJSIgd2lkdGg9IjE0MCUiIGhlaWdodD0iMTQwJSI+PGZlRHJvcFNoYWRvdyBkeD0iMCIgZHk9IjgiIHN0ZERldmlhdGlvbj0iMTAiIGZsb29kLWNvbG9yPSIjMUIxMTUwIiBmbG9vZC1vcGFjaXR5PSIuMyIvPjwvZmlsdGVyPgogIDwvZGVmcz4KICA8cmVjdCB4PSIxNiIgeT0iMTYiIHdpZHRoPSI0ODAiIGhlaWdodD0iNDgwIiByeD0iMTEyIiBmaWxsPSJ1cmwoI3RpbGUpIi8+CiAgPGcgZmlsdGVyPSJ1cmwoI2Ryb3ApIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNDQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMTI4IDIwMGgyMzZsLTcyLTcyIi8+CiAgICA8cGF0aCBkPSJNMzg0IDMxMkgxNDhsNzIgNzIiLz4KICA8L2c+Cjwvc3ZnPgo="
      },
      {
          "id": "translate",
          "name": "Deluxe Translate",
          "tag": "Text & photos",
          "url": "https://deluxe-translate-app.vercel.app/",
          "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEZWx1eGUgVHJhbnNsYXRlIj4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0idGlsZSIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmZmZmZiIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0VDRUVGNyIvPjwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9Im5hdnkiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMzNTUwQzgiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMxQzJDODAiLz48L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJicmFzcyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI0U2Q0M4NSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0M5QTU0OCIvPjwvbGluZWFyR3JhZGllbnQ+CiAgICA8ZmlsdGVyIGlkPSJkcm9wIiB4PSItMjAlIiB5PSItMjAlIiB3aWR0aD0iMTQwJSIgaGVpZ2h0PSIxNDAlIj48ZmVEcm9wU2hhZG93IGR4PSIwIiBkeT0iMTAiIHN0ZERldmlhdGlvbj0iMTIiIGZsb29kLWNvbG9yPSIjMTAxNDJBIiBmbG9vZC1vcGFjaXR5PSIuMjIiLz48L2ZpbHRlcj4KICA8L2RlZnM+CiAgPHJlY3QgeD0iMTYiIHk9IjE2IiB3aWR0aD0iNDgwIiBoZWlnaHQ9IjQ4MCIgcng9IjExMiIgZmlsbD0idXJsKCN0aWxlKSIgc3Ryb2tlPSIjRDhEQkU2IiBzdHJva2Utd2lkdGg9IjQiLz4KICA8ZyBmaWx0ZXI9InVybCgjZHJvcCkiPgogICAgPHBhdGggZD0iTTEyOCAxMThoMTcyYTQwIDQwIDAgMCAxIDQwIDQwdjEwNGE0MCA0MCAwIDAgMS00MCA0MGgtOTZsLTUyIDQ0di00NGgtMjRhNDAgNDAgMCAwIDEtNDAtNDBWMTU4YTQwIDQwIDAgMCAxIDQwLTQweiIgZmlsbD0idXJsKCNuYXZ5KSIvPgogICAgPHBhdGggZD0iTTM4NCAyMTRIMjYyYTM2IDM2IDAgMCAwLTM2IDM2djkyYTM2IDM2IDAgMCAwIDM2IDM2aDc4bDQ2IDQwdi00MGgtMmEzNiAzNiAwIDAgMCAzNi0zNnYtOTJhMzYgMzYgMCAwIDAtMzYtMzZ6IiBmaWxsPSJ1cmwoI2JyYXNzKSIvPgogIDwvZz4KICA8cGF0aCBkPSJNMTc2IDI2MmwzOC0xMDRoMjJsMzggMTA0aC0yOGwtOC0yNGgtMjZsLTggMjR6bTQzLTQ2aDE2bC04LTI2eiIgZmlsbD0iI2ZmZiIvPgogIDxyZWN0IHg9IjI1OCIgeT0iMjYyIiB3aWR0aD0iMTA0IiBoZWlnaHQ9IjE4IiByeD0iOSIgZmlsbD0iIzEwMTQyQSIgb3BhY2l0eT0iLjg1Ii8+CiAgPHJlY3QgeD0iMjU4IiB5PSIyOTgiIHdpZHRoPSIxMzIiIGhlaWdodD0iMTgiIHJ4PSI5IiBmaWxsPSIjMTAxNDJBIiBvcGFjaXR5PSIuNyIvPgogIDxyZWN0IHg9IjI1OCIgeT0iMzM0IiB3aWR0aD0iODAiIGhlaWdodD0iMTgiIHJ4PSI5IiBmaWxsPSIjMTAxNDJBIiBvcGFjaXR5PSIuNTUiLz4KPC9zdmc+Cg=="
      },
      {
          "id": "youtube",
          "name": "YouTube Guider AI",
          "tag": "Channel insights",
          "url": "https://deluxe-youtube-guider.vercel.app/",
          "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJZb3VUdWJlIEd1aWRlciBBSSI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InRpbGUiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMyQTJBMzMiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMxNDE0MTgiLz48L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJyZWQiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNGRjU0NzAiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNFMDEyMkYiLz48L2xpbmVhckdyYWRpZW50PgogICAgPGZpbHRlciBpZD0iZHJvcCIgeD0iLTIwJSIgeT0iLTIwJSIgd2lkdGg9IjE0MCUiIGhlaWdodD0iMTQwJSI+PGZlRHJvcFNoYWRvdyBkeD0iMCIgZHk9IjEyIiBzdGREZXZpYXRpb249IjE0IiBmbG9vZC1jb2xvcj0iI0ZGMjM0OCIgZmxvb2Qtb3BhY2l0eT0iLjMiLz48L2ZpbHRlcj4KICA8L2RlZnM+CiAgPHJlY3QgeD0iMTYiIHk9IjE2IiB3aWR0aD0iNDgwIiBoZWlnaHQ9IjQ4MCIgcng9IjExMiIgZmlsbD0idXJsKCN0aWxlKSIgc3Ryb2tlPSIjMzMzMzNDIiBzdHJva2Utd2lkdGg9IjQiLz4KICA8ZyBmaWx0ZXI9InVybCgjZHJvcCkiPgogICAgPGNpcmNsZSBjeD0iMjI4IiBjeT0iMjI2IiByPSIxMTIiIGZpbGw9IiMxRTFFMjUiIHN0cm9rZT0idXJsKCNyZWQpIiBzdHJva2Utd2lkdGg9IjM2Ii8+CiAgICA8cGF0aCBkPSJNMzA4IDMwNmw5MiA5MiIgc3Ryb2tlPSJ1cmwoI3JlZCkiIHN0cm9rZS13aWR0aD0iNDQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogIDwvZz4KICA8cGF0aCBkPSJNMjAwIDE3NnYxMDBsODQtNTB6IiBmaWxsPSIjZmZmIi8+CiAgPHBhdGggZD0iTTM4MCAxMTJsMTAgMjYgMjYgMTAtMjYgMTAtMTAgMjYtMTAtMjYtMjYtMTAgMjYtMTB6IiBmaWxsPSIjRkZEMTY2Ii8+CiAgPHBhdGggZD0iTTEyMCAxMjBsNiAxNSAxNSA2LTE1IDYtNiAxNS02LTE1LTE1LTYgMTUtNnoiIGZpbGw9IiNGRkQxNjYiIG9wYWNpdHk9Ii44Ii8+Cjwvc3ZnPgo="
      }
  ];

  var CSS = ".dlx-btn{--dlx-fg:#1f2433;--dlx-hover:rgba(20,30,60,.08);display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:40px;height:40px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--dlx-fg);cursor:pointer;font:600 13px/1 system-ui,-apple-system,\"Segoe UI\",sans-serif;-webkit-tap-highlight-color:transparent;transition:background .15s}\n.dlx-btn[data-dlx-theme=dark]{--dlx-fg:#e9ecf5;--dlx-hover:rgba(255,255,255,.1)}\n.dlx-btn:hover,.dlx-btn[aria-expanded=true]{background:var(--dlx-hover)}\n.dlx-btn:focus-visible{outline:2px solid #6b8cff;outline-offset:2px}\n.dlx-btn svg{flex:none}\n.dlx-panel{--dlx-bg:#fff;--dlx-fg:#161a24;--dlx-muted:#667085;--dlx-line:#e3e6ee;--dlx-hover:#f2f4f9;--dlx-here:#eef2ff;--dlx-ring:#4f6bff;position:fixed;z-index:2147483000;width:340px;max-width:calc(100vw - 16px);background:var(--dlx-bg);color:var(--dlx-fg);border:1px solid var(--dlx-line);border-radius:20px;box-shadow:0 18px 50px rgba(10,15,40,.22),0 2px 8px rgba(10,15,40,.08);padding:14px 14px 10px;font:14px/1.35 system-ui,-apple-system,\"Segoe UI\",sans-serif;animation:dlx-in .14s ease-out;box-sizing:border-box}\n.dlx-panel *{box-sizing:border-box}\n.dlx-panel[data-dlx-theme=dark]{--dlx-bg:#1b1e27;--dlx-fg:#eef0f6;--dlx-muted:#9aa3b6;--dlx-line:#2e3342;--dlx-hover:#252a36;--dlx-here:#262d45;--dlx-ring:#8ea2ff;box-shadow:0 18px 50px rgba(0,0,0,.55)}\n.dlx-head{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 10px}\n.dlx-head b{font-size:15px;letter-spacing:-.1px}\n.dlx-x{width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:var(--dlx-muted);font-size:22px;line-height:1;cursor:pointer}\n.dlx-x:hover{background:var(--dlx-hover);color:var(--dlx-fg)}\n.dlx-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}\n.dlx-app{display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 4px 10px;border-radius:14px;color:inherit;text-decoration:none;text-align:center;transition:background .12s}\n.dlx-app:hover{background:var(--dlx-hover)}\n.dlx-app:focus-visible{outline:2px solid var(--dlx-ring);outline-offset:-2px}\n.dlx-app img{width:48px;height:48px;display:block;border-radius:12px}\n.dlx-name{font-weight:650;font-size:13px;line-height:1.2}\n.dlx-tag{font-size:11px;color:var(--dlx-muted);line-height:1.2}\n.dlx-here{background:var(--dlx-here)}\n.dlx-here .dlx-tag{color:var(--dlx-ring);font-weight:600}\n.dlx-foot{margin:8px 4px 2px;padding-top:9px;border-top:1px solid var(--dlx-line);font-size:11px;color:var(--dlx-muted);text-align:center}\n.dlx-panel.dlx-sheet{left:8px!important;right:8px;top:auto!important;bottom:8px;width:auto;max-width:none;border-radius:22px;padding-bottom:max(10px,env(safe-area-inset-bottom));animation:dlx-up .18s ease-out}\n@keyframes dlx-in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}\n@keyframes dlx-up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}\n@media (prefers-reduced-motion:reduce){.dlx-panel,.dlx-panel.dlx-sheet{animation:none}}\n.dlx-scrim{display:none;position:fixed;inset:0;z-index:2147482999;background:rgba(8,10,20,.42);animation:dlx-fade .18s ease-out}\n.dlx-scrim.dlx-on{display:block}\n@keyframes dlx-fade{from{opacity:0}to{opacity:1}}";

  var GRID = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">' +
    '<circle cx="5" cy="5" r="2.1"/><circle cx="12" cy="5" r="2.1"/><circle cx="19" cy="5" r="2.1"/>' +
    '<circle cx="5" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="19" cy="12" r="2.1"/>' +
    '<circle cx="5" cy="19" r="2.1"/><circle cx="12" cy="19" r="2.1"/><circle cx="19" cy="19" r="2.1"/></svg>';

  function addStyle() {
    if (document.getElementById('dlx-style')) return;
    var s = document.createElement('style');
    s.id = 'dlx-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function themeOf(want) {
    if (want === 'dark' || want === 'light') return want;
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var open = null; // { panel, anchor, onKey, onDown }

  function close() {
    if (!open) return;
    var o = open;
    open = null;
    document.removeEventListener('keydown', o.onKey, true);
    document.removeEventListener('pointerdown', o.onDown, true);
    window.removeEventListener('resize', o.place);
    o.panel.remove();
    o.scrim.remove();
    if (o.anchor) {
      o.anchor.setAttribute('aria-expanded', 'false');
      try { o.anchor.focus(); } catch (e) {}
    }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function show(anchor, opts) {
    opts = opts || {};
    if (open) { var same = open.anchor === anchor; close(); if (same) return; }
    addStyle();
    var current = opts.current || '';
    var panel = el('div', 'dlx-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Deluxe apps');
    panel.setAttribute('data-dlx-theme', themeOf(opts.theme));

    var head = el('div', 'dlx-head');
    head.appendChild(el('b', null, 'Deluxe apps'));
    var x = el('button', 'dlx-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.onclick = close;
    head.appendChild(x);
    panel.appendChild(head);

    var grid = el('div', 'dlx-grid');
    APPS.forEach(function (app) {
      var here = app.id === current;
      var a = el('a', 'dlx-app' + (here ? ' dlx-here' : ''));
      a.href = app.url;
      if (here) a.setAttribute('aria-current', 'page');
      else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      var img = el('img');
      img.src = app.icon;
      img.alt = '';
      img.width = 48;
      img.height = 48;
      a.appendChild(img);
      a.appendChild(el('span', 'dlx-name', app.name));
      a.appendChild(el('span', 'dlx-tag', here ? 'You are here' : app.tag));
      if (here) a.onclick = function (e) { e.preventDefault(); close(); };
      grid.appendChild(a);
    });
    panel.appendChild(grid);
    panel.appendChild(el('p', 'dlx-foot', 'Made by Deluxe Lord · Directed by Shivad Sujith'));
    var scrim = el('div', 'dlx-scrim');
    document.body.appendChild(scrim);
    document.body.appendChild(panel);

    function place() {
      var sheet = window.innerWidth < 560 || !anchor;
      scrim.classList.toggle('dlx-on', sheet);
      if (sheet) {
        panel.classList.add('dlx-sheet');
        panel.style.top = panel.style.left = panel.style.right = '';
        return;
      }
      panel.classList.remove('dlx-sheet');
      var r = anchor.getBoundingClientRect();
      var w = panel.offsetWidth;
      var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      panel.style.left = left + 'px';
      panel.style.top = Math.min(r.bottom + 8, window.innerHeight - panel.offsetHeight - 8) + 'px';
    }
    place();

    var onKey = function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    var onDown = function (e) {
      if (!panel.contains(e.target) && !(anchor && anchor.contains(e.target))) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    open = { panel: panel, scrim: scrim, anchor: anchor, onKey: onKey, onDown: onDown, place: place };
    var first = grid.querySelector('a:not(.dlx-here)') || x;
    try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
  }

  function mount(host, opts) {
    if (!host || host.getAttribute('data-dlx-ready')) return;
    host.setAttribute('data-dlx-ready', '1');
    opts = opts || {};
    addStyle();
    var current = opts.current || host.getAttribute('data-current') || '';
    var theme = opts.theme || host.getAttribute('data-theme') || 'auto';
    var b = el('button', 'dlx-btn');
    b.type = 'button';
    b.innerHTML = GRID;
    b.setAttribute('aria-label', 'Deluxe apps');
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.title = 'Deluxe apps';
    b.setAttribute('data-dlx-theme', themeOf(theme));
    if (host.getAttribute('data-label') !== null) {
      b.appendChild(el('span', 'dlx-label', host.getAttribute('data-label') || 'Apps'));
      b.classList.add('dlx-wide');
    }
    b.onclick = function () {
      b.setAttribute('data-dlx-theme', themeOf(theme));
      show(b, { current: current, theme: theme });
    };
    host.appendChild(b);
    return b;
  }

  function mountAll() {
    var hosts = document.querySelectorAll('[data-deluxe-apps]');
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }

  window.DeluxeApps = { apps: APPS, mount: mount, open: show, close: close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})();
