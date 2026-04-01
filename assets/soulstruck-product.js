/**
 * SoulStruck Product Page — Custom Interactions
 * Enhances the product page with offer banner styling, trust badges,
 * read-more toggle, addon cards, and scroll animations.
 *
 * Because Shopify sanitizes custom HTML attributes in text settings,
 * this script adds the styling classes via DOM manipulation after page load.
 */

(function () {
  'use strict';

  /* =============================================
     1. OFFER BANNER — Find and Style
     ============================================= */
  function initOfferBanner() {
    // Find the text block named "Offer Banner" by matching content pattern
    var textBlocks = document.querySelectorAll('.product-details .text-block');
    textBlocks.forEach(function (block) {
      var text = block.textContent || '';
      if (text.match(/BUY ANY \d+/i) || text.match(/@\d+/)) {
        // Found the offer banner
        var para = block.querySelector('p');
        if (para) {
          para.classList.add('ss-offer-banner');
        } else {
          block.classList.add('ss-offer-banner');
        }
      }
    });
  }

  /* =============================================
     2. STAR RATING — Find and Enhance
     ============================================= */
  function initStarRating() {
    var textBlocks = document.querySelectorAll('.product-details .text-block');
    textBlocks.forEach(function (block) {
      var text = block.textContent || '';
      // Match blocks that contain star characters and "Reviews"
      if ((text.indexOf('★') !== -1 || text.indexOf('☆') !== -1) && text.indexOf('Reviews') !== -1) {
        block.classList.add('ss-rating-block');

        var para = block.querySelector('p');
        if (para) {
          para.classList.add('ss-rating');
        }
      }
    });
  }

  /* =============================================
     3. PRODUCT DESCRIPTION — Read More Toggle
     ============================================= */
  function initReadMore() {
    // Find the product description block
    var descBlocks = document.querySelectorAll('.product-details .text-block.rte, .product-details .text-block[data-type="product-description"]');
    
    // Also try to find by the rte content which contains product description HTML
    if (descBlocks.length === 0) {
      descBlocks = document.querySelectorAll('.product-details .rte');
    }

    descBlocks.forEach(function (desc) {
      // Only add Read More if content is tall enough
      if (desc.scrollHeight <= 100) return;
      
      // Create wrapper
      var wrapper = document.createElement('div');
      wrapper.className = 'ss-description is-collapsed';
      
      // Move description content into wrapper
      while (desc.firstChild) {
        wrapper.appendChild(desc.firstChild);
      }
      desc.appendChild(wrapper);
      
      // Create Read More button
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ss-read-more';
      btn.textContent = 'Read More';
      desc.appendChild(btn);
      
      btn.addEventListener('click', function () {
        var isCollapsed = wrapper.classList.contains('is-collapsed');
        if (isCollapsed) {
          wrapper.style.maxHeight = wrapper.scrollHeight + 'px';
          wrapper.classList.remove('is-collapsed');
          btn.textContent = 'Read Less';
        } else {
          wrapper.style.maxHeight = '';
          wrapper.classList.add('is-collapsed');
          btn.textContent = 'Read More';
        }
      });
    });
  }

  /* =============================================
     4. TRUST BADGES — Inject After Buy Buttons
     ============================================= */
  function initTrustBadges() {
    var buyButtons = document.querySelector('.product-details .buy-buttons');
    if (!buyButtons) {
      buyButtons = document.querySelector('.product-details [data-testid="buy-buttons"]');
    }

    // Find the parent wrapper of buy buttons to insert after
    var insertTarget = buyButtons;
    if (!insertTarget) return;

    // Walk up to the block-level wrapper
    while (insertTarget && !insertTarget.classList.contains('block-wrapper') && insertTarget.parentElement && !insertTarget.parentElement.classList.contains('group-block')) {
      insertTarget = insertTarget.parentElement;
    }

    // Create trust badges HTML
    var trustHTML = '<div class="ss-trust-badges">' +
      '<div class="ss-trust-badge">' +
        '<span class="ss-trust-badge__icon">' +
          '<svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>' +
        '</span>' +
        '<span>100% Authentic</span>' +
      '</div>' +
      '<div class="ss-trust-badge">' +
        '<span class="ss-trust-badge__icon">' +
          '<svg viewBox="0 0 24 24"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>' +
        '</span>' +
        '<span>Free Shipping</span>' +
      '</div>' +
      '<div class="ss-trust-badge">' +
        '<span class="ss-trust-badge__icon">' +
          '<svg viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>' +
        '</span>' +
        '<span>Easy Returns</span>' +
      '</div>' +
      '<div class="ss-trust-badge">' +
        '<span class="ss-trust-badge__icon">' +
          '<svg viewBox="0 0 24 24"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>' +
        '</span>' +
        '<span>Secure Payment</span>' +
      '</div>' +
    '</div>';

    var trustEl = document.createElement('div');
    trustEl.innerHTML = trustHTML;

    // Insert after the buy buttons area
    if (insertTarget.nextSibling) {
      insertTarget.parentNode.insertBefore(trustEl.firstChild, insertTarget.nextSibling);
    } else {
      insertTarget.parentNode.appendChild(trustEl.firstChild);
    }
  }

  /* =============================================
     5. ADDON / UPSELL "BUY NOW" — AJAX Add to Cart
     ============================================= */
  function initAddonButtons() {
    var addonButtons = document.querySelectorAll('.ss-addon-card__cta[data-variant-id]');

    addonButtons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        var variantId = btn.getAttribute('data-variant-id');
        if (!variantId) return;

        var originalText = btn.textContent;
        btn.textContent = 'Adding...';
        btn.setAttribute('disabled', 'true');

        fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ id: parseInt(variantId), quantity: 1 }],
          }),
        })
          .then(function (response) {
            if (response.ok) {
              btn.textContent = 'Added ✓';
              btn.style.background = '#2E7D32';
              btn.style.color = '#fff';
              btn.style.borderColor = '#2E7D32';

              setTimeout(function () {
                btn.textContent = originalText;
                btn.style.background = '';
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.removeAttribute('disabled');
              }, 2000);
            } else {
              throw new Error('Failed to add');
            }
          })
          .catch(function () {
            btn.textContent = 'Error';
            setTimeout(function () {
              btn.textContent = originalText;
              btn.removeAttribute('disabled');
            }, 1500);
          });
      });
    });
  }

  /* =============================================
     6. SCROLL ANIMATIONS (Intersection Observer)
     ============================================= */
  function initScrollAnimations() {
    var elements = document.querySelectorAll('.ss-fade-in');
    if (!elements.length) return;

    if (!('IntersectionObserver' in window)) {
      elements.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    elements.forEach(function (el) { observer.observe(el); });
  }

  /* =============================================
     7. ADDON CARD CLICK — Go to product (whole card)
     ============================================= */
  function initAddonCardLinks() {
    var cards = document.querySelectorAll('.ss-addon-card[data-product-url]');
    cards.forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.ss-addon-card__cta')) return;
        var url = card.getAttribute('data-product-url');
        if (url) window.location.href = url;
      });
    });
  }

  /* =============================================
     INIT — Run when DOM is ready
     ============================================= */
  function init() {
    initOfferBanner();
    initStarRating();
    initReadMore();
    initTrustBadges();
    initAddonButtons();
    initScrollAnimations();
    initAddonCardLinks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
