/*
  Links assets/ss-smart-cart.css into the Shiprocket Smart Cart shadow root,
  and corrects the cart's totals.

  The app attaches an open shadow root to #shiprocket-smart-cart-root and then
  appends its own <style> tags at different times (base CSS after a fetch, the
  banner styles once the cart loads). Rules of equal specificity resolve by
  order, so the skin is moved back to the end whenever the app adds a style.

  Totals: Shiprocket's "Estimated Total" comes from its server with a prepaid
  discount (a flat ₹449) already taken off, but checkout doesn't apply that —
  it offers its own smaller prepaid discount per payment method — so the side
  cart promised less than checkout charges. It also struck through the
  pre-offer subtotal while its "You're saving" banner counts savings on MRP,
  so the three numbers didn't add up. Wherever the cart shows totals:
    total  = Shiprocket's total + its prepaid discount  (= the Shopify cart
             total = what checkout charges before shipping)
    struck = total + the "You're saving" amount         (= the MRP total)
  The add-to-cart popup reads the same numbers via window.ssSmartCartTotals().
*/
(function () {
  var script = document.currentScript;
  var href = script && script.getAttribute('data-css');
  if (!href) return;

  var LINK_ID = 'ss-smart-cart-skin';
  var OURS = '__ssSmartCart'; // marks text nodes this script wrote

  var cartRoot = null;
  var srTotal = NaN; // Shiprocket's own figure for the total, in paise

  function keepLast(root, link) {
    if (root.lastElementChild !== link) root.appendChild(link);
  }

  /* ── Totals ─────────────────────────────────────────────────────────── */

  // "₹3,698.40" / "-₹449" → 369840 / 44900; NaN when there's no number
  function paise(text) {
    var m = String(text || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Math.round(parseFloat(m[0]) * 100) : NaN;
  }

  function money(value) {
    var rupees = value / 100;
    var digits = value % 100 ? 2 : 0;
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: digits,
        maximumFractionDigits: 2,
      }).format(rupees);
    } catch (e) {
      return '₹' + rupees.toFixed(digits);
    }
  }

  // Shiprocket rewrites these with innerHTML, which replaces the text node,
  // so a marked node means the value on screen is still ours.
  function ours(el) {
    return !!(el.firstChild && el.firstChild[OURS]);
  }

  function write(el, text) {
    if (ours(el) && el.textContent === text) return;
    el.textContent = text;
    if (el.firstChild) el.firstChild[OURS] = true;
  }

  function badgeAmount(badge) {
    var b = badge && !badge.classList.contains('hidden') && badge.querySelector('b');
    var v = b ? paise(b.textContent) : NaN;
    return v > 0 ? v : 0;
  }

  function computeTotals(root) {
    var totalEl = root.querySelector('.sr-cart-total-price-amount .total-price');
    if (!totalEl) return null;
    if (!ours(totalEl)) srTotal = paise(totalEl.textContent);
    if (isNaN(srTotal)) return null;

    var prepaidRow = root.getElementById('sr-cart-prepaid-discount-container');
    var prepaidEl = root.getElementById('sr-cart-prepaid-discount');
    var prepaid = prepaidRow && prepaidEl && !prepaidRow.classList.contains('hidden') ? paise(prepaidEl.textContent) : 0;
    var total = srTotal + (prepaid > 0 ? prepaid : 0);

    var saving = badgeAmount(root.getElementById('footer-combined-offer-badge'));
    var was = saving > 0 ? total + saving : NaN;
    if (isNaN(was)) {
      var sub = root.querySelector('.sr-sub-total');
      was = sub ? paise(sub.textContent) : NaN;
    }
    return { total: total, was: was > total ? was : null, saving: saving };
  }

  function fixTotals(root) {
    var t = computeTotals(root);
    if (!t) return null;

    write(root.querySelector('.sr-cart-total-price-amount .total-price'), money(t.total));

    var wasEl = root.querySelector('.sr-cart-total-price-amount .summary-original-price');
    if (wasEl) {
      if (t.was) {
        write(wasEl, money(t.was));
        if (wasEl.style.display !== 'block') wasEl.style.display = 'block';
      } else if (wasEl.style.display !== 'none') {
        wasEl.style.display = 'none';
      }
    }

    // Same number format in the savings banners (Shiprocket's ₹ sits outside <b>)
    ['footer-combined-offer-badge', 'summary-combined-offer-badge'].forEach(function (id) {
      var badge = root.getElementById(id);
      var b = badge && badge.querySelector('b');
      if (!b || ours(b)) return;
      var v = paise(b.textContent);
      if (v > 0) write(b, money(v).replace(/^[^\d]+/, ''));
    });
    return t;
  }

  // For the add-to-cart popup: { total, was, saving } in paise, or null.
  window.ssSmartCartTotals = function () {
    return cartRoot ? fixTotals(cartRoot) : null;
  };

  function skin(root) {
    cartRoot = root;
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

    // Correct totals whenever Shiprocket re-renders them. Runs as a microtask
    // before paint, so its numbers never show; our own writes settle in one pass.
    new MutationObserver(function () {
      fixTotals(root);
    }).observe(root, { childList: true, characterData: true, subtree: true });
    fixTotals(root);
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
