// The service worker can't create blob URLs, so it asks this hidden page to.
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type !== 'make-blob-url') return;
  reply(URL.createObjectURL(new Blob([m.json], { type: 'application/json' })));
});
