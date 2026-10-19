/*
  Add-to-cart confirmation popup: the step between "Add to cart" and the
  Shiprocket side cart. "View cart" opens the side cart, "Checkout" goes
  straight to Shiprocket checkout (the same call as the side cart's Buy Now).

  How adds are caught:
  - Shiprocket's capture-phase listener performs almost every add on the site
    (product form, cards: anything with data-variant-id + "add to cart" text)
    and then calls window.slideShiprocketSmartCartInFrame(). That global is
    wrapped so that, right after a successful /cart/add, the popup opens
    instead of the drawer. Clicking the cart icon still opens the drawer.
  - Sections that add with their own fetch() are caught by watching
    /cart/add responses that follow a click on an add-to-cart control.
  Shiprocket's checkout (fastrr) also posts to /cart/add when restoring a
  cart, so a response alone never opens the popup.

  The bag total comes from /cart.js. The discount nudge and "You're saving"
  are read from the Shiprocket cart (its shadow DOM) once it has refreshed,
  so they always match the side cart.

  Must load before Shiprocket's scripts (it is in <head>, they are in <body>)
  so the globals are wrapped before Shiprocket assigns them.
*/
(function () {
  'use strict';

  var root = document.getElementById('ss-atc');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = 'true';

  var INTENT_MS = 6000; // add-to-cart click → /cart/add response
  var ADD_MS = 4000; // /cart/add response → Shiprocket's drawer-open call
  var CLOSE_MS = 320;

  var ADD_SELECTOR = [
    '[data-ss-atc]:not([data-ss-buy-link])',
    '[data-add-cart]',
    '[data-pts-add-to-cart]',
    '[data-wishlist-add-to-cart]',
    '.ni-ps-card__atc',
    'form[action*="/cart/add"] [type="submit"]',
    'form[action*="/cart/add"] [name="add"]',
  ].join(',');
  var NOT_ADD_SELECTOR = '.shiprocket-headless, [data-ss-buy-link], [name="sr-headless-button"], #shiprocket-smart-cart-root';

  function q(sel) {
    return root.querySelector(sel);
  }

  var panel = q('[data-ss-atc-panel]');
  var el = {
    media: q('.ss-atc__media'),
    img: q('[data-ss-atc-img]'),
    name: q('[data-ss-atc-name]'),
    variant: q('[data-ss-atc-variant]'),
    price: q('[data-ss-atc-price]'),
    compare: q('[data-ss-atc-compare]'),
    off: q('[data-ss-atc-off]'),
    nudge: q('[data-ss-atc-nudge]'),
    nudgeText: q('[data-ss-atc-nudge-text]'),
    summary: q('[data-ss-atc-summary]'),
    items: q('[data-ss-atc-items]'),
    total: q('[data-ss-atc-total]'),
    totalWas: q('[data-ss-atc-total-was]'),
    saving: q('[data-ss-atc-saving]'),
    count: q('[data-ss-atc-count]'),
    view: q('[data-ss-atc-view]'),
    checkout: q('[data-ss-atc-checkout]'),
    pay: q('[data-ss-atc-pay]'),
    live: q('[data-ss-atc-live]'),
  };

  var nativeFetch = window.fetch;
  var nativeSlide = null;
  var nativeUpdate = null;

  var intent = null; // { at, el } — last click on an add-to-cart control
  var pendingAdd = null; // { at, item } — last successful /cart/add
  var current = null; // the add the popup is showing
  var isOpen = false;
  var lastTrigger = null;
  var expectedCount = null; // cart item_count after the add
  var currentCart = null; // /cart.js after the add
  var updating = 0; // Shiprocket cart refreshes in flight
  var drawerObserver = null;
  var syncTimer = null;
  var selfRefreshTimer = null;
  var checkoutObserver = null;
  var checkoutTimer = null;

  /* ── Shiprocket helpers ─────────────────────────────────────────────── */

  function srRoot() {
    var host = document.getElementById('shiprocket-smart-cart-root');
    return host && host.shadowRoot;
  }

  function drawerOpen() {
    var r = srRoot();
    var c = r && r.getElementById('shiprocket-mini-cart-container');
    return !!c && c.style.display === 'block';
  }

  function checkoutOpen() {
    if (document.getElementById('headless-container') || document.getElementById('fastrr-main-container')) return true;
    var pre = document.getElementById('fastrr-pre-loader');
    return !!pre && pre.style.display !== 'none';
  }

  /*
    Wrap a global that Shiprocket assigns later (or already assigned). The
    getter stays undefined until the real function exists, so Shiprocket's
    own "typeof x === 'function'" readiness checks keep working.
  */
  function hookGlobal(name, setNative, getNative, wrapper) {
    var desc = Object.getOwnPropertyDescriptor(window, name);
    if (desc && !desc.configurable) return;
    if (desc && 'value' in desc && typeof desc.value === 'function') setNative(desc.value);
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: function () {
        return getNative() ? wrapper : undefined;
      },
      set: function (fn) {
        setNative(fn);
      },
    });
  }

  hookGlobal(
    'slideShiprocketSmartCartInFrame',
    function (fn) { nativeSlide = fn; },
    function () { return nativeSlide; },
    function () {
      var add = pendingAdd;
      if (add && Date.now() - add.at < ADD_MS && !drawerOpen()) {
        pendingAdd = null;
        if (current === add) return; // already showing this add
        try {
          show(add, intent && intent.el);
          return;
        } catch (e) {
          /* fall through to the drawer rather than showing nothing */
        }
      }
      return nativeSlide.apply(this, arguments);
    }
  );

  hookGlobal(
    'updateMiniCartSection',
    function (fn) { nativeUpdate = fn; },
    function () { return nativeUpdate; },
    function () {
      updating++;
      var result;
      try {
        result = nativeUpdate.apply(this, arguments);
      } catch (e) {
        updating--;
        throw e;
      }
      Promise.resolve(result).then(done, done);
      return result;
      function done() {
        updating = Math.max(0, updating - 1);
        scheduleSync();
      }
    }
  );

  /* ── Detecting adds ─────────────────────────────────────────────────── */

  function isCartAdd(input, init) {
    var url = typeof input === 'string' ? input : input && input.url;
    if (!url) return false;
    var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
    if (String(method).toUpperCase() !== 'POST') return false;
    try {
      return /\/cart\/add(\.js)?$/.test(new URL(url, location.href).pathname);
    } catch (e) {
      return false;
    }
  }

  function firstItem(data) {
    if (data && Array.isArray(data.items)) return data.items[0] || null;
    return data && data.variant_id ? data : null;
  }

  function onAddResponse(res) {
    if (!res || !res.ok || drawerOpen() || checkoutOpen()) return;
    var item;
    try {
      item = res.clone().json().then(firstItem, function () { return null; });
    } catch (e) {
      item = Promise.resolve(null);
    }
    var add = { at: Date.now(), item: item };
    pendingAdd = add;

    if (intent && Date.now() - intent.at < INTENT_MS) {
      var trigger = intent.el;
      intent = null;
      show(add, trigger);
    }
  }

  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var p = nativeFetch.apply(window, arguments);
      try {
        if (isCartAdd(input, init)) p.then(onAddResponse, function () {});
      } catch (e) {
        /* never let the popup interfere with a request */
      }
      return p;
    };
  }

  function addControl(target) {
    var hit = target.closest(ADD_SELECTOR);
    if (!hit) {
      var btn = target.closest('button, a, [role="button"], input[type="submit"]');
      if (btn) {
        var label = [btn.getAttribute('aria-label'), btn.textContent, btn.value].join(' ');
        if (/\badd\b[\s\S]{0,80}?\bto\s+(cart|bag)\b/i.test(label) && !/buy\s*(it\s*)?now/i.test(label)) hit = btn;
      }
    }
    return hit && !hit.closest(NOT_ADD_SELECTOR) ? hit : null;
  }

  // Window capture runs before Shiprocket's document-level capture listener.
  window.addEventListener(
    'click',
    function (event) {
      var t = event.target;
      if (!t || !t.closest || root.contains(t)) return;
      var hit = addControl(t);
      if (hit) intent = { at: Date.now(), el: hit };
    },
    true
  );

  // The kit pickers block the add when no kit is chosen — nothing was added.
  function clearIntent() {
    intent = null;
  }
  document.addEventListener('ss:variant-required', clearIntent);
  document.addEventListener('ss:kit-required', clearIntent);

  /* ── Rendering ──────────────────────────────────────────────────────── */

  function money(cents) {
    if (typeof cents !== 'number' || isNaN(cents)) return '';
    var value = cents / 100;
    var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'INR';
    var digits = value % 1 ? 2 : 0;
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: 2,
      }).format(value);
    } catch (e) {
      return '₹' + value.toFixed(digits);
    }
  }

  function sized(url, width) {
    if (!url) return '';
    try {
      var u = new URL(url, location.href);
      u.searchParams.set('width', String(width));
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  // "₹1,258.20" / "-₹139.80" → 125820 (paise); NaN when there's no number
  function paise(text) {
    var m = String(text || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Math.round(parseFloat(m[0]) * 100) : NaN;
  }

  function setText(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  }

  function resetView() {
    el.media.classList.remove('is-loaded');
    el.img.hidden = true;
    el.img.removeAttribute('src');
    el.name.textContent = '';
    setText(el.variant, '');
    el.price.textContent = '';
    setText(el.compare, '');
    setText(el.off, '');
    el.nudge.hidden = true;
    el.summary.hidden = true;
    setText(el.totalWas, '');
    el.count.textContent = '';
    expectedCount = null;
    currentCart = null;
  }

  function renderItem(item) {
    var name = item.product_title || item.title || '';
    el.name.textContent = name;

    var variant = item.variant_title;
    if (!variant || variant === 'Default Title') variant = '';
    if (item.quantity > 1) variant = (variant ? variant + ' · ' : '') + 'Qty ' + item.quantity;
    setText(el.variant, variant);

    var price = typeof item.original_price === 'number' ? item.original_price : item.price;
    el.price.textContent = money(price);

    var image = (item.featured_image && item.featured_image.url) || item.image;
    if (image) {
      el.img.onload = function () {
        el.media.classList.add('is-loaded');
      };
      el.img.src = sized(image, 240);
      el.img.alt = (item.featured_image && item.featured_image.alt) || name;
      el.img.hidden = false;
    } else {
      el.media.classList.add('is-loaded');
    }

    el.live.textContent = name + ' added to your bag';

    // Compare-at price isn't on cart lines; read it from the product.
    if (item.handle && item.variant_id) {
      nativeFetch
        .call(window, (window.Shopify && window.Shopify.routes && window.Shopify.routes.root || '/') + 'products/' + item.handle + '.js', {
          headers: { Accept: 'application/json' },
        })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (product) {
          if (!product || !isOpen || !current || current.itemData !== item) return;
          var v = (product.variants || []).filter(function (x) {
            return x.id === item.variant_id;
          })[0];
          if (!v || !(v.compare_at_price > price)) return;
          setText(el.compare, money(v.compare_at_price));
          setText(el.off, Math.round(((v.compare_at_price - price) / v.compare_at_price) * 100) + '% OFF');
        })
        .catch(function () {});
    }
  }

  /*
    Bag total straight from Shopify: total_price already includes the
    automatic "buy more" discount and matches what checkout charges before
    shipping. (Shiprocket's "Estimated Total" also deducts a prepaid discount
    that only applies to online payment, so it can't be used here.)
  */
  function renderTotal(cart, saving) {
    // With Shiprocket's saving (offers + MRP) known, strike through the MRP
    // total so "was − now" equals the saving shown, as checkout does.
    var was = saving > 0 ? cart.total_price + saving : cart.original_total_price;
    el.total.textContent = money(cart.total_price);
    setText(el.totalWas, was > cart.total_price ? money(was) : '');
    el.items.textContent = '(' + cart.item_count + (cart.item_count === 1 ? ' item)' : ' items)');
    el.summary.hidden = false;
  }

  /* Pull the nudge, savings and payment icons from the side cart once it
     reflects this add (its item count matches the cart's). */
  function syncFromDrawer() {
    if (!isOpen) return;
    if (drawerOpen()) {
      // Something opened the drawer directly — get out of its way.
      close(false);
      return;
    }
    var r = srRoot();
    if (!r) return;

    var pay = r.getElementById('sr-cart-payment-icon');
    if (pay && pay.getAttribute('src') && el.pay.hidden) {
      el.pay.src = pay.getAttribute('src');
      el.pay.alt = pay.getAttribute('alt') || '';
      el.pay.hidden = false;
    }

    if (expectedCount === null || updating > 0) return;
    var qty = r.getElementById('sr-cart-header-quantity');
    var n = qty ? parseInt((qty.textContent || '').replace(/\D/g, ''), 10) : NaN;
    if (n !== expectedCount) return;

    var sub = r.querySelector('.progress-bar-sub-heading');
    var nudge = sub && sub.textContent.replace(/\s+/g, ' ').trim();
    el.nudgeText.textContent = nudge || '';
    el.nudge.hidden = !nudge;

    // Shiprocket's "You're saving ₹X" (offers + savings on MRP)
    var badge = r.getElementById('footer-combined-offer-badge');
    var saving = '';
    if (badge && !badge.classList.contains('hidden') && badge.style.display !== 'none') {
      var m = (badge.textContent || '').match(/₹\s?[\d,]+(?:\.\d+)?/);
      var amount = m ? paise(m[0]) : NaN;
      if (amount > 0) saving = "You're saving " + money(amount) + ' on this order';
    }
    setText(el.saving, saving);
    if (currentCart) renderTotal(currentCart, saving ? amount : 0);
  }

  function scheduleSync() {
    if (!isOpen) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncFromDrawer, 120);
  }

  function observeDrawer() {
    var r = srRoot();
    if (!r || drawerObserver) return;
    drawerObserver = new MutationObserver(scheduleSync);
    drawerObserver.observe(r, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  function refreshCart(add) {
    nativeFetch
      .call(window, (window.Shopify && window.Shopify.routes && window.Shopify.routes.root || '/') + 'cart.js', {
        headers: { Accept: 'application/json' },
      })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        if (current !== add || !cart) return;
        expectedCount = cart.item_count;
        currentCart = cart;
        el.count.textContent = '(' + cart.item_count + ')';
        renderTotal(cart, 0);
        syncFromDrawer();

        // Adds that bypassed Shiprocket leave its cart stale; refresh it so
        // "View cart" and the summary are right. Shiprocket's own adds are
        // already refreshing by now.
        clearTimeout(selfRefreshTimer);
        selfRefreshTimer = setTimeout(function () {
          if (current !== add || updating > 0 || typeof window.updateMiniCartSection !== 'function') return;
          var r = srRoot();
          var qty = r && r.getElementById('sr-cart-header-quantity');
          var n = qty ? parseInt((qty.textContent || '').replace(/\D/g, ''), 10) : NaN;
          if (n !== expectedCount) {
            try {
              window.updateMiniCartSection();
            } catch (e) {}
          }
        }, 700);
      })
      .catch(function () {});
  }

  /* ── Open / close ───────────────────────────────────────────────────── */

  function show(add, trigger) {
    current = add;
    lastTrigger = trigger || document.activeElement;
    resetView();
    resetCheckout();
    open();

    add.item.then(function (item) {
      if (current !== add) return;
      if (item) {
        add.itemData = item;
        renderItem(item);
      } else {
        el.name.textContent = 'Item added';
        el.media.classList.add('is-loaded');
      }
    });
    refreshCart(add);
  }

  function open() {
    if (isOpen) {
      syncFromDrawer();
      return;
    }
    isOpen = true;
    root.hidden = false;
    document.documentElement.classList.add('ss-atc-lock');
    void root.offsetWidth; // start the transition from the closed state
    root.classList.add('is-open');
    try {
      panel.focus({ preventScroll: true });
    } catch (e) {
      panel.focus();
    }
    document.addEventListener('keydown', onKeydown, true);
    observeDrawer();
    syncFromDrawer();
  }

  function close(restoreFocus) {
    if (!isOpen) return;
    isOpen = false;
    current = null;
    pendingAdd = null;
    expectedCount = null;
    clearTimeout(syncTimer);
    clearTimeout(selfRefreshTimer);
    if (drawerObserver) {
      drawerObserver.disconnect();
      drawerObserver = null;
    }
    document.removeEventListener('keydown', onKeydown, true);
    root.classList.remove('is-open');
    document.documentElement.classList.remove('ss-atc-lock');
    setTimeout(function () {
      if (!isOpen) root.hidden = true;
    }, CLOSE_MS);
    if (restoreFocus && lastTrigger && document.contains(lastTrigger) && lastTrigger.focus) {
      try {
        lastTrigger.focus({ preventScroll: true });
      } catch (e) {}
    }
    lastTrigger = null;
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep focus inside the dialog
    var focusable = Array.prototype.filter.call(
      panel.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      function (n) {
        return n.offsetParent !== null;
      }
    );
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ── Actions ────────────────────────────────────────────────────────── */

  function viewCart() {
    close(false);
    if (nativeSlide) {
      nativeSlide(true); // true: refresh the drawer as it opens
    } else {
      window.location.href = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root || '/') + 'cart';
    }
  }

  function resetCheckout() {
    clearTimeout(checkoutTimer);
    if (checkoutObserver) {
      checkoutObserver.disconnect();
      checkoutObserver = null;
    }
    el.checkout.classList.remove('is-loading');
    el.checkout.removeAttribute('aria-busy');
  }

  function checkout() {
    if (el.checkout.classList.contains('is-loading')) return;
    el.checkout.classList.add('is-loading');
    el.checkout.setAttribute('aria-busy', 'true');

    // Close once Shiprocket's checkout layer is on screen.
    checkoutObserver = new MutationObserver(function () {
      if (checkoutOpen()) {
        resetCheckout();
        close(false);
      }
    });
    checkoutObserver.observe(document.body, { childList: true, subtree: true });
    checkoutTimer = setTimeout(resetCheckout, 12000);

    try {
      if (typeof window.handleShiprocketSmartCartBuy === 'function') {
        // Same path as the side cart's Buy Now (Shiprocket checkout, with
        // Shopify checkout as its own fallback).
        window.handleShiprocketSmartCartBuy();
      } else {
        window.location.href = '/checkout';
      }
    } catch (e) {
      window.location.href = '/checkout';
    }
  }

  root.addEventListener('click', function (event) {
    var t = event.target;
    if (t.closest('[data-ss-atc-close]')) {
      close(true);
    } else if (t.closest('[data-ss-atc-view]')) {
      viewCart();
    } else if (t.closest('[data-ss-atc-checkout]')) {
      checkout();
    }
  });

  // Back from checkout via bfcache: don't come back to a stuck popup.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      resetCheckout();
      close(false);
    }
  });
})();
