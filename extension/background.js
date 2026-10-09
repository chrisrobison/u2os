// Opens the side panel when the toolbar button is clicked. Nothing else runs in the background:
// the side panel talks to U2OS, and the content script is injected only into the job's tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
