/*
 * SoulStruck Wishlist — vanilla JS, no dependencies.
 * Source of truth: localStorage (works for guests AND logged-in customers,
 * persists across refreshes/devices-on-same-browser).
 *
 * Logged-in customers: on load we READ an optional server-rendered customer
 * metafield (snippets/wishlist-data.liquid) and MERGE it into localStorage,
 * de-duplicated. WRITING back to a customer metafield is NOT possible from
 * theme JS (Shopify platform limitation) — see pushToCustomer() below for the
 * documented App Proxy extension point.
 *
 * Self-contained: this file is additive and namespaced (window.Wishlist).
 * It does not touch cart, checkout, search, filters or any existing JS.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'soulstruck:wishlist:v1';
  var EVENT = 'wishlist:updated';

  /* ----------------------------- Utilities ----------------------------- */
  function safeParse(json, fallback) {
    try {
      var v = JSON.parse(json);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------- Store -------------------------------- */
  function read() {
    if (!window.localStorage) return [];
    var items = safeParse(localStorage.getItem(STORAGE_KEY), []);
    if (!Array.isArray(items)) return [];
    return items.filter(function (i) {
      return i && typeof i.handle === 'string' && i.handle.length;
    });
  }

  function persist(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      /* storage may be full or disabled; fail silently */
    }
    document.dispatchEvent(new CustomEvent(EVENT, { detail: { items: items } }));
  }

  function has(handle) {
    return read().some(function (i) {
      return i.handle === handle;
    });
  }

  function add(handle, id) {
    if (!handle) return;
    var items = read();
    var exists = items.some(function (i) {
      return i.handle === handle;
    });
    if (exists) return; // prevent duplicates
    items.push({ handle: handle, id: id ? String(id) : null, addedAt: Date.now() });
    persist(items);
    pushToCustomer(items);
  }

  function remove(handle) {
    var next = read().filter(function (i) {
      return i.handle !== handle;
    });
    persist(next);
    pushToCustomer(next);
  }

  function toggle(handle, id) {
    if (has(handle)) {
      remove(handle);
    } else {
      add(handle, id);
    }
  }

  function count() {
    return read().length;
  }

  /* ----------- Optional logged-in sync via Shopify App Proxy ------------ */
  /* Writing customer metafields requires the Admin API, which cannot be
   * called from theme JS. If you later create an App Proxy (e.g. /apps/wishlist)
   * backed by a small serverless function that persists the list to a customer
   * metafield, set window.WISHLIST_SYNC_URL to that path and this will POST to
   * it. Until then it is a safe no-op. */
  function pushToCustomer(items) {
    var url = window.WISHLIST_SYNC_URL;
    if (!url || !window.__wishlistLoggedIn) return;
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handles: items.map(function (i) {
            return i.handle;
          })
        })
      }).catch(function () {});
    } catch (e) {}
  }

  /* --------- Merge server (customer metafield) -> local on load --------- */
  function mergeFromServer() {
    var el = document.getElementById('wishlist-customer-data');
    if (!el) return;
    var data = safeParse(el.textContent, null);
    if (!data) return;
    window.__wishlistLoggedIn = !!data.loggedIn;
    if (!data.loggedIn || !Array.isArray(data.items) || !data.items.length) return;

    var items = read();
    var seen = {};
    items.forEach(function (i) {
      seen[i.handle] = true;
    });
    var changed = false;
    data.items.forEach(function (s) {
      if (s && s.handle && !seen[s.handle]) {
        items.push({ handle: s.handle, id: s.id ? String(s.id) : null, addedAt: Date.now() });
        seen[s.handle] = true;
        changed = true;
      }
    });
    if (changed) persist(items);
  }

  /* ------------------------------ UI sync ------------------------------- */
  function syncButtons(root) {
    var scope = root || document;
    var saved = {};
    read().forEach(function (i) {
      saved[i.handle] = true;
    });
    var btns = scope.querySelectorAll('[data-wishlist-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var active = !!saved[btn.getAttribute('data-wishlist-handle')];
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      var label = active
        ? btn.getAttribute('data-label-remove') || 'In wishlist'
        : btn.getAttribute('data-label-add') || 'Add to wishlist';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }

  function syncCount() {
    var n = count();
    var nodes = document.querySelectorAll('[data-wishlist-count]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = String(n);
      if (n === 0) {
        nodes[i].setAttribute('hidden', '');
      } else {
        nodes[i].removeAttribute('hidden');
      }
    }
  }

  function syncAll() {
    syncButtons();
    syncCount();
  }

  /* --------------------------- Event handling --------------------------- */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;

    // Heart toggle (cards, PDP, modal)
    var toggleBtn = e.target.closest('[data-wishlist-toggle]');
    if (toggleBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggle(toggleBtn.getAttribute('data-wishlist-handle'), toggleBtn.getAttribute('data-wishlist-id'));
      toggleBtn.classList.remove('wishlist-btn--bounce');
      void toggleBtn.offsetWidth; // restart animation
      toggleBtn.classList.add('wishlist-btn--bounce');
      return;
    }

    // Remove (wishlist page)
    var removeBtn = e.target.closest('[data-wishlist-remove]');
    if (removeBtn) {
      e.preventDefault();
      remove(removeBtn.getAttribute('data-handle'));
      return;
    }

    // Add to cart (wishlist page)
    var atcBtn = e.target.closest('[data-wishlist-add-to-cart]');
    if (atcBtn) {
      e.preventDefault();
      addToCart(atcBtn);
      return;
    }
  });

  document.addEventListener(EVENT, function () {
    syncAll();
    renderPageIfNeeded();
  });

  // Keep wishlist in sync across browser tabs.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      syncAll();
      renderPageIfNeeded();
    }
  });

  // Re-hydrate hearts when new product cards / modal content are injected
  // (AJAX filtering/pagination, quick-add modal). Debounced via rAF.
  var rafId = null;
  function scheduleSync() {
    if (rafId) return;
    rafId = window.requestAnimationFrame(function () {
      rafId = null;
      syncButtons();
    });
  }
  function observe() {
    if (!window.MutationObserver || !document.body) return;
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
          scheduleSync();
          return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------- Money formatting --------------------------- */
  function formatMoney(cents, format) {
    format = format || '${{amount}}';
    function fmt(precision, thousands, decimal) {
      var num = (Number(cents) / 100).toFixed(precision);
      var parts = num.split('.');
      var dollars = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      var rest = parts[1] ? decimal + parts[1] : '';
      return dollars + rest;
    }
    return format.replace(/\{\{\s*(\w+)\s*\}\}/g, function (match, key) {
      switch (key) {
        case 'amount':
          return fmt(2, ',', '.');
        case 'amount_no_decimals':
          return fmt(0, ',', '.');
        case 'amount_with_comma_separator':
          return fmt(2, '.', ',');
        case 'amount_no_decimals_with_comma_separator':
          return fmt(0, '.', ',');
        case 'amount_with_apostrophe_separator':
          return fmt(2, "'", '.');
        case 'amount_with_space_separator':
          return fmt(2, ' ', ',');
        case 'amount_no_decimals_with_space_separator':
          return fmt(0, ' ', ',');
        default:
          return fmt(2, ',', '.');
      }
    });
  }

  function sizedImage(url, w) {
    if (!url) return '';
    if (url.indexOf('//') === 0) url = 'https:' + url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'width=' + w;
  }

  /* ------------------------- Wishlist page view ------------------------- */
  function labels(app) {
    return {
      add: (app && app.getAttribute('data-t-add')) || 'Add to cart',
      options: (app && app.getAttribute('data-t-options')) || 'Select options',
      soldOut: (app && app.getAttribute('data-t-soldout')) || 'Sold out',
      inStock: (app && app.getAttribute('data-t-instock')) || 'In stock'
    };
  }

  var CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function cardHTML(p, format, l) {
    var rawImg = p.featured_image || (p.images && p.images[0]) || '';
    var imgUrl = rawImg ? sizedImage(rawImg, 500) : '';
    var available = !!p.available;
    var price = formatMoney(p.price, format);
    var compare =
      p.compare_at_price && p.compare_at_price > p.price
        ? '<s class="wl-card__compare">' + formatMoney(p.compare_at_price, format) + '</s>'
        : '';

    var variants = p.variants || [];
    var firstAvailable = variants.filter(function (v) {
      return v.available;
    })[0];
    var action;
    if (!available || !firstAvailable) {
      action = '<button type="button" class="wl-card__atc" disabled>' + escapeHtml(l.soldOut) + '</button>';
    } else if (variants.length > 1) {
      action =
        '<a class="wl-card__atc wl-card__atc--link" href="/products/' +
        escapeHtml(p.handle) +
        '">' +
        escapeHtml(l.options) +
        '</a>';
    } else {
      action =
        '<button type="button" class="wl-card__atc" data-wishlist-add-to-cart data-variant-id="' +
        escapeHtml(firstAvailable.id) +
        '">' +
        escapeHtml(l.add) +
        '</button>';
    }

    return (
      '<article class="wl-card" data-wl-item="' + escapeHtml(p.handle) + '">' +
      '<a class="wl-card__media" href="/products/' + escapeHtml(p.handle) + '">' +
      (imgUrl
        ? '<img src="' + escapeHtml(imgUrl) + '" alt="' + escapeHtml(p.title) + '" loading="lazy" width="500" height="625">'
        : '<span class="wl-card__noimg" aria-hidden="true"></span>') +
      '</a>' +
      '<button type="button" class="wl-card__remove" data-wishlist-remove data-handle="' +
      escapeHtml(p.handle) +
      '" aria-label="Remove from wishlist">' +
      CLOSE_SVG +
      '</button>' +
      '<div class="wl-card__body">' +
      '<a class="wl-card__title" href="/products/' + escapeHtml(p.handle) + '">' + escapeHtml(p.title) + '</a>' +
      '<div class="wl-card__price">' + price + (compare ? ' ' + compare : '') + '</div>' +
      '<div class="wl-card__avail ' + (available ? 'is-in' : 'is-out') + '">' +
      (available ? escapeHtml(l.inStock) : escapeHtml(l.soldOut)) +
      '</div>' +
      action +
      '</div>' +
      '</article>'
    );
  }

  var pageRendering = false;
  function renderPageIfNeeded() {
    var app = document.getElementById('wishlist-app');
    if (app) renderPage(app);
  }

  function renderPage(app) {
    if (pageRendering) return;
    var grid = app.querySelector('[data-wishlist-grid]');
    var empty = app.querySelector('[data-wishlist-empty]');
    var loading = app.querySelector('[data-wishlist-loading]');
    if (!grid) return;

    var items = read();
    var format = app.getAttribute('data-money-format') || '${{amount}}';
    var l = labels(app);

    function show(node, visible) {
      if (node) {
        if (visible) {
          node.removeAttribute('hidden');
        } else {
          node.setAttribute('hidden', '');
        }
      }
    }

    if (!items.length) {
      grid.innerHTML = '';
      show(loading, false);
      show(empty, true);
      return;
    }

    show(empty, false);
    show(loading, true);
    pageRendering = true;

    var requests = items.map(function (it) {
      return fetch('/products/' + encodeURIComponent(it.handle) + '.js', {
        headers: { Accept: 'application/json' }
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        });
    });

    Promise.all(requests).then(function (products) {
      show(loading, false);
      var html = '';
      var missing = [];
      products.forEach(function (p, idx) {
        if (!p) {
          missing.push(items[idx].handle);
          return;
        }
        html += cardHTML(p, format, l);
      });
      grid.innerHTML = html;
      pageRendering = false;

      // Prune products that no longer exist (404). persist() re-emits the event,
      // which re-renders once with the cleaned list.
      if (missing.length) {
        var kept = read().filter(function (i) {
          return missing.indexOf(i.handle) === -1;
        });
        persist(kept);
        return;
      }
      if (!grid.children.length) show(empty, true);
    });
  }

  /* ----------------------- Add to cart (wishlist) ----------------------- */
  function addToCart(btn) {
    var id = btn.getAttribute('data-variant-id');
    if (!id) return;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: Number(id), quantity: 1 }] })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('add_failed');
        return r.json();
      })
      .then(function () {
        btn.textContent = 'Added ✓';
        // Let other components know the cart changed (best-effort, non-breaking).
        document.dispatchEvent(new CustomEvent('wishlist:cart-added', { detail: { id: id } }));
        window.setTimeout(function () {
          btn.textContent = original;
          btn.disabled = false;
        }, 1800);
      })
      .catch(function () {
        btn.textContent = 'Try again';
        window.setTimeout(function () {
          btn.textContent = original;
          btn.disabled = false;
        }, 1800);
      });
  }

  /* -------------------------------- Init -------------------------------- */
  function init() {
    mergeFromServer();
    syncAll();
    renderPageIfNeeded();
    observe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Minimal public API (optional, for future extensions / debugging).
  window.Wishlist = {
    add: add,
    remove: remove,
    toggle: toggle,
    has: has,
    count: count,
    all: read
  };
})();
