/* ============================================================
   SoulStruck Mega Menu — "Show more" for long columns
   - Hides items past the threshold (default 7)
   - Adds a Show more / Show less toggle
   - Works with Shopify's standard .mega-menu__column markup
   - Re-runs on Shopify section reload (theme editor)
   ============================================================ */
(function () {
  var THRESHOLD = 7;

  function processColumn(column) {
    if (!column || column.dataset.ssMegaProcessed === '1') return;

    // Find the deepest <ul> of links (skip the column wrapper itself)
    var lists = column.querySelectorAll('ul');
    var listEl = null;
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].children.length > 0) { listEl = lists[i]; break; }
    }
    if (!listEl) return;

    var items = listEl.querySelectorAll(':scope > li');
    if (items.length <= THRESHOLD) {
      column.dataset.ssMegaProcessed = '1';
      return;
    }

    column.classList.add('ss-mega-column');
    for (var j = THRESHOLD; j < items.length; j++) {
      items[j].classList.add('ss-mega-hidden');
    }

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ss-mega-show-more';
    toggle.textContent = 'Show more';
    toggle.setAttribute('aria-expanded', 'false');

    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var expanded = column.classList.toggle('is-expanded');
      toggle.textContent = expanded ? 'Show less' : 'Show more';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });

    listEl.parentNode.appendChild(toggle);
    column.dataset.ssMegaProcessed = '1';
  }

  function run(scope) {
    var root = scope || document;
    var columns = root.querySelectorAll('.menu-list__submenu .mega-menu__column');
    columns.forEach(processColumn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { run(); });
  } else {
    run();
  }

  // Re-run when Shopify's editor swaps a header section
  document.addEventListener('shopify:section:load', function (e) {
    run(e.target);
  });
  document.addEventListener('shopify:block:select', function (e) {
    run(e.target);
  });
})();
