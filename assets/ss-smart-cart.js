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

  Savings strip: Shiprocket's "You're saving" banner above Buy Now is rebuilt
  as "🎉 You're saving ₹X | ⏱ 09:59 left ⌄". The 10-minute countdown starts
  the first time the shopper opens the cart with items in it, carries across
  pages for the browser tab's session, and disappears at 00:00 rather than
  starting over. The chevron opens the bill summary.
*/
(function () {
  var script = document.currentScript;
  var href = script && script.getAttribute('data-css');
  if (!href) return;

  var LINK_ID = 'ss-smart-cart-skin';
  var OURS = '__ssSmartCart'; // marks text nodes this script wrote

  var TIMER_MS = 10 * 60 * 1000;
  var TIMER_KEY = 'ss-cart-timer-end'; // sessionStorage: when the countdown ends (ms)

  var cartRoot = null;
  var srTotal = NaN; // Shiprocket's own figure for the total, in paise
  var timerEndFallback = 0; // when sessionStorage is unavailable
  var tickInterval = null;

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

    decorateSavings(root, t.saving);

    // Same number format in the bill summary's savings line (Shiprocket's ₹ sits outside <b>)
    var summaryBadge = root.getElementById('summary-combined-offer-badge');
    var sb = summaryBadge && summaryBadge.querySelector('b');
    if (sb && !ours(sb)) {
      var v = paise(sb.textContent);
      if (v > 0) write(sb, money(v).replace(/^[^\d]+/, ''));
    }
    return t;
  }

  /* ── Savings strip + countdown ──────────────────────────────────────── */

  var EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
  var STOPWATCH =
    '<svg class="ss-timer__icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 1.5"/><path d="M10 2.5h4M12 2.5V6"/>' +
    '<path d="m18.5 6.5 1.3-1.3M5.5 6.5 4.2 5.2"/></svg>';
  var CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  // Shiprocket refills the banner (innerHTML) whenever savings change; rebuild it each time.
  function decorateSavings(root, saving) {
    var badge = root.getElementById('footer-combined-offer-badge');
    if (!badge || badge.querySelector('.ss-save')) return;

    var save = node('span', 'ss-save');
    var icon = node('span', 'ss-save__icon', '🎉');
    icon.setAttribute('aria-hidden', 'true');
    var text = node('span', 'ss-save__text');
    if (saving > 0) {
      text.appendChild(document.createTextNode("You're saving "));
      text.appendChild(node('b', null, money(saving)));
    } else {
      // e.g. "🎉 Continue to safe checkout 🎉!" → "Continue to safe checkout"
      text.textContent = (badge.textContent || '').replace(EMOJI, '').replace(/!+\s*$/, '').trim();
    }
    save.appendChild(icon);
    save.appendChild(text);

    var timer = node('span', 'ss-timer');
    timer.setAttribute('role', 'timer');
    timer.innerHTML =
      STOPWATCH +
      '<span class="ss-timer__pill"><strong class="ss-timer__time"></strong> <span class="ss-timer__left">left</span></span>';

    var more = node('button', 'ss-save__more');
    more.type = 'button';
    more.setAttribute('aria-label', 'See how you save');
    more.innerHTML = CHEVRON;

    badge.textContent = '';
    badge.appendChild(save);
    badge.appendChild(timer);
    badge.appendChild(more);
    renderTimer(root);

    if (!badge[OURS]) {
      badge[OURS] = true;
      badge.addEventListener('click', function (event) {
        if (event.target.closest('.ss-save__more') && typeof window.toggleSmartCartOrderSummary === 'function') {
          window.toggleSmartCartOrderSummary();
        }
      });
    }
  }

  function drawerShowing(root) {
    var c = root.getElementById('shiprocket-mini-cart-container');
    return !!c && c.style.display === 'block';
  }

  function itemCount(root) {
    var q = root.getElementById('sr-cart-header-quantity');
    return q ? parseInt((q.textContent || '').replace(/\D/g, ''), 10) || 0 : 0;
  }

  function timerEnd(start) {
    var end = 0;
    try {
      end = Number(window.sessionStorage.getItem(TIMER_KEY)) || 0;
    } catch (e) {
      end = timerEndFallback;
    }
    if (!end && start) {
      end = Date.now() + TIMER_MS;
      timerEndFallback = end;
      try {
        window.sessionStorage.setItem(TIMER_KEY, String(end));
      } catch (e) {}
    }
    return end;
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function renderTimer(root) {
    var timer = root.querySelector('#footer-combined-offer-badge .ss-timer');
    if (!timer) return;
    var end = timerEnd(drawerShowing(root) && itemCount(root) > 0);
    var left = end ? end - Date.now() : TIMER_MS; // not started yet: full 10:00
    if (left <= 0) {
      if (!timer.hidden) timer.hidden = true; // time's up: drop it, don't restart
      return;
    }
    var s = Math.ceil(left / 1000);
    var text = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
    var time = timer.querySelector('.ss-timer__time');
    if (time && time.textContent !== text) time.textContent = text;
  }

  // Tick once a second, only while the side cart is open.
  function watchDrawer(root) {
    var container = root.getElementById('shiprocket-mini-cart-container');
    if (!container) return;
    function sync() {
      if (drawerShowing(root)) {
        renderTimer(root);
        if (!tickInterval) {
          tickInterval = setInterval(function () {
            renderTimer(root);
          }, 1000);
        }
      } else if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
    }
    new MutationObserver(sync).observe(container, { attributes: true, attributeFilter: ['style'] });
    sync();
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
    // The countdown's own once-a-second updates are skipped.
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var target = mutations[i].target;
        var el = target.nodeType === 1 ? target : target.parentNode;
        if (!(el && el.closest && el.closest('.ss-timer'))) {
          fixTotals(root);
          return;
        }
      }
    }).observe(root, { childList: true, characterData: true, subtree: true });
    fixTotals(root);
    watchDrawer(root);
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
