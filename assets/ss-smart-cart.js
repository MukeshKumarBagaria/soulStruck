/*
  Links assets/ss-smart-cart.css into the Shiprocket Smart Cart shadow root.

  The app attaches an open shadow root to #shiprocket-smart-cart-root and then
  appends its own <style> tags at different times (base CSS after a fetch, the
  banner styles once the cart loads). Rules of equal specificity resolve by
  order, so the skin is moved back to the end whenever the app adds a style.
*/
(function () {
  var script = document.currentScript;
  var href = script && script.getAttribute('data-css');
  if (!href) return;

  var LINK_ID = 'ss-smart-cart-skin';

  function keepLast(root, link) {
    if (root.lastElementChild !== link) root.appendChild(link);
  }

  function skin(root) {
    var link = root.getElementById(LINK_ID);
    if (!link) {
      link = document.createElement('link');
      link.id = LINK_ID;
      link.rel = 'stylesheet';
      link.href = href;
    }
    keepLast(root, link);

    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node !== link && (node.nodeName === 'STYLE' || node.nodeName === 'LINK')) {
            keepLast(root, link);
            return;
          }
        }
      }
    }).observe(root, { childList: true });
  }

  function init() {
    var host = document.getElementById('shiprocket-smart-cart-root');
    if (!host) return false;
    if (host.shadowRoot) {
      skin(host.shadowRoot);
      return true;
    }
    return false;
  }

  if (init()) return;

  // The app creates the shadow root from a deferred script; poll briefly.
  var tries = 0;
  var timer = setInterval(function () {
    if (init() || ++tries > 100) clearInterval(timer);
  }, 100);
})();
