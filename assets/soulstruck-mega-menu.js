/* ============================================================
   SoulStruck Mega Menu — "Show more" toggle for long columns
   Targets the custom header (.ni-ch__megamenu-col / .ni-ch__megamenu-list)
   - Hides items past THRESHOLD
   - Adds a Show more / Show less button styled via CSS
   - Re-runs on Shopify section reload (theme editor)
   ============================================================ */
(function () {
  var THRESHOLD = 6;

  function processColumn(column) {
    if (!column || column.dataset.ssMegaProcessed === '1') return;

    var listEl = column.querySelector('.ni-ch__megamenu-list');
    if (!listEl) return;

    var items = listEl.querySelectorAll(':scope > li');
    if (items.length <= THRESHOLD) {
      column.dataset.ssMegaProcessed = '1';
      return;
    }

    for (var j = THRESHOLD; j < items.length; j++) {
      items[j].classList.add('ss-mega-hidden');
    }

    var existing = column.querySelector('.ss-mega-show-more');
    if (existing) existing.remove();

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

    column.appendChild(toggle);
    column.dataset.ssMegaProcessed = '1';
  }

  function run(scope) {
    var root = scope || document;
    var columns = root.querySelectorAll('.ni-ch__megamenu-col');
    columns.forEach(processColumn);
  }

  function reset(scope) {
    var root = scope || document;
    var columns = root.querySelectorAll('.ni-ch__megamenu-col');
    columns.forEach(function (col) {
      col.removeAttribute('data-ss-mega-processed');
      col.classList.remove('is-expanded');
      col.querySelectorAll('.ss-mega-hidden').forEach(function (el) {
        el.classList.remove('ss-mega-hidden');
      });
      var btn = col.querySelector('.ss-mega-show-more');
      if (btn) btn.remove();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { run(); });
  } else {
    run();
  }

  // Re-run when Shopify's editor swaps a header section
  document.addEventListener('shopify:section:load', function (e) {
    reset(e.target);
    run(e.target);
  });
  document.addEventListener('shopify:section:reorder', function (e) {
    reset(e.target);
    run(e.target);
  });
  document.addEventListener('shopify:block:select', function (e) {
    run(e.target);
  });
})();
