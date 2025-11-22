// Content script to get viewport dimensions
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getViewportInfo') {
    sendResponse({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio
    });
  }
  return true;
});
