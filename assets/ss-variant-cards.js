/**
 * SoulStruck — one variant controller for every custom product card.
 *
 * The card markup (bestsellers, tabs slider, collection card, showcase, video cards)
 * used to display `product.price` (the CHEAPEST variant) while adding
 * `product.selected_or_first_available_variant` (the FIRST variant) to the cart.
 * Those are two different variants whenever the first variant is not the cheapest,
 * which is why the mini-cart showed a different price than the card.
 *
 * This file makes the selected variant the single source of truth for a card:
 * price, compare-at, save badge, image, add-to-cart id, buy-now permalink and the
 * product link all read from it. Multi-variant products start with NO selection and
 * cannot be added to cart until the shopper picks one.
 *
 * One delegated listener set on `document` serves every card on the page, including
 * cards injected later by the Section Rendering API or a slider.
 */
(function () {
  'use strict';

  var SCOPE = '[data-ss-scope]';
  var cache = new WeakMap();

  /** Parse (once) the variant payload a card carries. */
  function variantsOf(scope) {
    if (cache.has(scope)) return cache.get(scope);
    var node = scope.querySelector(':scope [data-ss-variants]');
    var list = [];
    if (node) {
      try {
        list = JSON.parse(node.textContent || '[]');
      } catch (err) {
        console.error('[ss-variant] bad variant payload', err, scope);
      }
    }
    cache.set(scope, list);
    return list;
  }

  function findVariant(scope, id) {
    var wanted = String(id);
    return variantsOf(scope).find(function (v) {
      return String(v.id) === wanted;
    });
  }

  function q(scope, selector) {
    return scope.querySelector(':scope ' + selector);
  }

  function qa(scope, selector) {
    return Array.prototype.slice.call(scope.querySelectorAll(':scope ' + selector));
  }

  /** Swap a token template such as "SAVE {amount}" or "{percent}% off". */
  function fillTemplate(template, variant) {
    return template
      .replace('{amount}', variant.save_html || '')
      .replace('{percent}', String(variant.save_percent == null ? '' : variant.save_percent))
      .replace('{price}', variant.price_html || '')
      .replace('{compare}', variant.compare_html || '');
  }

  function show(el) {
    if (el) el.hidden = false;
  }

  function hide(el) {
    if (el) el.hidden = true;
  }

  /** Push a variant into every variant-dependent node of the card. */
  function apply(scope, variant) {
    scope.dataset.ssState = 'selected';
    scope.dataset.ssVariantId = String(variant.id);

    var price = q(scope, '[data-ss-price]');
    if (price) price.textContent = variant.price_html;

    // "From" only makes sense while no variant is chosen.
    hide(q(scope, '[data-ss-price-prefix]'));

    var compare = q(scope, '[data-ss-compare]');
    if (compare) {
      if (variant.on_sale) {
        compare.textContent = variant.compare_html;
        show(compare);
      } else {
        hide(compare);
      }
    }

    qa(scope, '[data-ss-save]').forEach(function (badge) {
      if (!variant.on_sale) {
        hide(badge);
        return;
      }
      var template = badge.dataset.ssSaveFormat || '{amount}';
      badge.textContent = fillTemplate(template, variant);
      show(badge);
    });

    // The id that actually reaches Shopify.
    qa(scope, '[data-ss-variant-id-input]').forEach(function (input) {
      input.value = String(variant.id);
      input.disabled = !variant.available;
    });

    qa(scope, '[data-ss-atc]').forEach(function (btn) {
      btn.setAttribute('data-variant-id', String(variant.id));
      if ('disabled' in btn) btn.disabled = !variant.available;
      btn.setAttribute('aria-disabled', variant.available ? 'false' : 'true');
    });

    qa(scope, '[data-ss-buy-link]').forEach(function (link) {
      var base = link.dataset.ssBuyBase || '/cart';
      link.href = base + '/' + variant.id + ':1';
    });

    // Requirement: carrying the choice through to the PDP.
    qa(scope, '[data-ss-product-link]').forEach(function (link) {
      if (!link.dataset.ssHrefBase) {
        link.dataset.ssHrefBase = (link.getAttribute('href') || '').split('?')[0];
      }
      link.href = link.dataset.ssHrefBase + '?variant=' + variant.id;
    });

    if (variant.image) {
      qa(scope, '[data-ss-image]').forEach(function (img) {
        if (!img.dataset.ssImageBase) img.dataset.ssImageBase = img.getAttribute('src') || '';
        img.removeAttribute('srcset');
        img.src = variant.image;
      });
    }

    hide(q(scope, '[data-ss-kit-error]'));
  }

  /** Initialise a card: single-variant products select themselves, others stay open. */
  function init(scope) {
    if (scope.dataset.ssReady === 'true') return;
    scope.dataset.ssReady = 'true';

    var variants = variantsOf(scope);
    var hasPicker = !!q(scope, '[data-ss-kit]');

    if (!hasPicker) {
      // One variant (or a default variant): behave exactly like stock Shopify.
      if (variants.length === 1) apply(scope, variants[0]);
      else scope.dataset.ssState = 'selected';
      return;
    }

    scope.dataset.ssState = 'unselected';

    // Honour a pre-checked pill (e.g. a card re-rendered after a section update).
    var checked = q(scope, '[data-ss-variant-input]:checked');
    if (checked) {
      var variant = findVariant(scope, checked.value);
      if (variant) apply(scope, variant);
    }
  }

  function initAll(root) {
    var container = root || document;
    Array.prototype.slice.call(container.querySelectorAll(SCOPE)).forEach(init);
  }

  /** Nudge the shopper toward the pills instead of silently adding variant #1. */
  function requireSelection(scope) {
    var picker = q(scope, '[data-ss-kit]');
    var error = q(scope, '[data-ss-kit-error]');

    show(error);
    if (picker) {
      picker.classList.remove('ss-kit--pulse');
      // Restart the animation on repeat clicks.
      void picker.offsetWidth;
      picker.classList.add('ss-kit--pulse');
      var firstInput = q(scope, '[data-ss-variant-input]:not([disabled])');
      if (firstInput) firstInput.focus({ preventScroll: true });
    }

    window.clearTimeout(scope.ssErrorTimer);
    scope.ssErrorTimer = window.setTimeout(function () {
      hide(error);
      if (picker) picker.classList.remove('ss-kit--pulse');
    }, 3000);
  }

  document.addEventListener('change', function (event) {
    var input = event.target.closest && event.target.closest('[data-ss-variant-input]');
    if (!input) return;
    var scope = input.closest(SCOPE);
    if (!scope) return;
    init(scope);

    var variant = findVariant(scope, input.value);
    if (variant) apply(scope, variant);
  });

  // Capture phase: this must win over each section's own click/submit handler so an
  // unselected card can never reach /cart/add.js with a fallback variant id.
  document.addEventListener(
    'click',
    function (event) {
      var target = event.target.closest && event.target.closest('[data-ss-atc]');
      if (!target) return;
      var scope = target.closest(SCOPE);
      if (!scope) return;
      init(scope);

      if (scope.dataset.ssState !== 'selected') {
        event.preventDefault();
        event.stopPropagation();
        requireSelection(scope);
      }
    },
    true
  );

  // Some cards are wrapped in an <a> (tabs slider) or in <product-card> (collection),
  // both of which navigate on click. Drive the radio ourselves so picking a kit never
  // leaves the page, on any card layout.
  document.addEventListener(
    'click',
    function (event) {
      var label = event.target.closest && event.target.closest('[data-ss-kit] label');
      if (!label) return;

      event.preventDefault();
      event.stopPropagation();

      var input = label.querySelector('[data-ss-variant-input]');
      if (!input || input.disabled || input.checked) return;

      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    true
  );

  // Run now for whatever is already parsed, and again once the document finishes, so
  // the cards are initialised whether this file loads deferred, async or injected.
  initAll();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initAll();
    });
  }

  // Sections re-rendered by the theme editor or the Section Rendering API.
  document.addEventListener('shopify:section:load', function (event) {
    initAll(event.target);
  });
})();
