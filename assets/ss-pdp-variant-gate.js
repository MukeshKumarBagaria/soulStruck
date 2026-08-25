/**
 * SoulStruck — explicit kit selection on the product page.
 *
 * Shopify always renders `selected_or_first_available_variant`, so a shopper landing
 * on a two-kit product sees Signature Edit already chosen and a price that they never
 * picked. `layout/theme.liquid` marks those page loads with `html.ss-kit-unselected`
 * (server-side, so nothing flashes); this script completes the gate:
 *
 *   - clears the auto-selection in the variant picker
 *   - swaps the price for "Select a kit to see price"
 *   - blocks add-to-cart / buy-now until a kit is chosen
 *
 * The gate lifts on the first selection and then hands over completely to the theme's
 * native variant picker, which owns the price, media, URL and hidden variant input.
 */
(function () {
  'use strict';

  var html = document.documentElement;
  if (!html.classList.contains('ss-kit-unselected')) return;

  var BUY_SELECTOR =
    'button[name="add"], .add-to-cart-button, .buy-buttons-block button, ' +
    '.buy-buttons-block a, sticky-add-to-cart button, .shiprocket-headless button';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var picker =
      document.querySelector('variant-picker[data-template-product-match="true"]') ||
      document.querySelector('variant-picker');

    if (!picker) {
      html.classList.remove('ss-kit-unselected');
      return;
    }

    // Scope everything to the main product column: the same section can also hold
    // complementary-product and recommendation cards, which must stay untouched.
    var root = picker.closest('.product-details') || picker.closest('.shopify-section') || document.body;
    var sticky = document.querySelector('sticky-add-to-cart');
    var injected = [];

    // 1. Undo Shopify's automatic first-variant selection.
    picker.querySelectorAll('input[type="radio"]').forEach(function (input) {
      input.checked = false;
      input.dataset.currentChecked = 'false';
      input.dataset.previousChecked = 'false';
    });

    picker.querySelectorAll('select').forEach(function (select) {
      if (select.querySelector('[data-ss-placeholder]')) return;
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select an option';
      placeholder.setAttribute('data-ss-placeholder', '');
      select.prepend(placeholder);
      select.value = '';
    });

    // 2. A price the shopper has not chosen yet is misleading — replace it.
    var priceHosts = Array.prototype.slice.call(root.querySelectorAll('.ss-price--kit-gated'));
    if (sticky) {
      priceHosts.push.apply(priceHosts, sticky.querySelectorAll('.sticky-add-to-cart__price'));
    }

    priceHosts.forEach(function (priceEl) {
      var prompt = document.createElement('p');
      prompt.className = 'ss-kit-gate__price';
      prompt.setAttribute('data-ss-kit-gate-node', '');
      prompt.textContent = 'Select a kit to see price';
      priceEl.insertAdjacentElement('afterend', prompt);
      injected.push(prompt);
    });

    // 3. Tell the shopper what is missing, next to the buttons they are reaching for.
    var message = document.createElement('p');
    message.className = 'ss-kit-gate__message';
    message.setAttribute('data-ss-kit-gate-node', '');
    message.setAttribute('role', 'status');
    message.hidden = true;
    message.textContent = 'Please select your kit';

    var buyBlock = root.querySelector('.buy-buttons-block');
    if (buyBlock) buyBlock.insertAdjacentElement('beforebegin', message);
    else picker.insertAdjacentElement('afterend', message);
    injected.push(message);

    var messageTimer;

    function flagMissingSelection() {
      message.hidden = false;
      picker.classList.remove('ss-kit-gate__picker--pulse');
      void picker.offsetWidth; // restart the animation on repeat clicks
      picker.classList.add('ss-kit-gate__picker--pulse');
      if (typeof picker.scrollIntoView === 'function') {
        picker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      window.clearTimeout(messageTimer);
      messageTimer = window.setTimeout(function () {
        message.hidden = true;
        picker.classList.remove('ss-kit-gate__picker--pulse');
      }, 3000);
    }

    // Capture phase so the theme's own submit handler never sees the click.
    // Complementary-product and recommendation cards are rendered INSIDE
    // .product-details, so containment alone is not enough to identify the main
    // product's buttons — those nested contexts own their own variant selection.
    var NESTED_PRODUCT_CONTEXT = 'product-card, quick-add-component, quick-add-modal, [data-ss-scope]';

    function blockBuy(event) {
      var button = event.target.closest && event.target.closest(BUY_SELECTOR);
      if (!button || picker.contains(button)) return;
      if (button.closest(NESTED_PRODUCT_CONTEXT)) return;
      if (!root.contains(button) && !(sticky && sticky.contains(button))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      flagMissingSelection();
    }

    // The inline guard in layout/theme.liquid blocks first (it beats the Shiprocket
    // Smart Cart capture listener); this renders the message it asks for.
    document.addEventListener('ss:kit-required', flagMissingSelection);

    // Fallback block for when the inline guard is absent.
    document.addEventListener('click', blockBuy, true);

    function release() {
      html.classList.remove('ss-kit-unselected');
      document.removeEventListener('click', blockBuy, true);
      document.removeEventListener('ss:kit-required', flagMissingSelection);
      window.clearTimeout(messageTimer);
      picker.classList.remove('ss-kit-gate__picker--pulse');
      injected.forEach(function (node) {
        node.remove();
      });
      picker.querySelectorAll('[data-ss-placeholder]').forEach(function (node) {
        node.remove();
      });
    }

    // The theme takes over from the very first choice.
    picker.addEventListener('change', release, { once: true });
  });
})();
