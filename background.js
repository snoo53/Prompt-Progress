chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "OPEN_DASHBOARD") {
    chrome.runtime.openOptionsPage();
  }
});
