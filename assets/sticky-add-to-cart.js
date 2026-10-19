import { Component } from '@theme/component';
import { ThemeEvents, QuantitySelectorUpdateEvent } from '@theme/events';
import { morph } from '@theme/morph';

/**
 * @typedef {Object} ProductVariant
 * @property {string|number} [id] - Variant ID
 * @property {string} [title] - Variant title
 * @property {string} [name] - Variant name
 * @property {boolean} [available] - Whether variant is available
 */

/**
 * @typedef {Object} StickyAddToCartRefs
 * @property {HTMLElement} stickyBar - The bar container
 * @property {HTMLButtonElement} addToCartButton - Sticky bar's add to cart button
 * @property {HTMLButtonElement} [buyNowButton] - Sticky bar's buy now button (optional)
 * @property {HTMLElement} quantityDisplay - Quantity display container
 * @property {HTMLElement} quantityNumber - Quantity number element
 */

/**
 * SoulStruck: a buy bar that stays on screen for the whole product page, holding
 * just Add to cart and Buy now. Each button clicks its twin in the buy block, so
 * the kit gate, Shiprocket and the add-to-cart popup behave exactly as they do there.
 *
 * @extends {Component<StickyAddToCartRefs>}
 */
class StickyAddToCartComponent extends Component {
  requiredRefs = ['stickyBar', 'addToCartButton', 'quantityDisplay', 'quantityNumber'];

  /**
   * Buy now buttons the sticky bar knows how to click: Shiprocket's headless checkout
   * first, then Shopify's own dynamic checkout button. Wallet buttons (Apple Pay, Google
   * Pay) live in cross-origin iframes and cannot be clicked from here, so they are left
   * out — the buy block itself still offers them.
   */
  static buyNowSelector = [
    '.shiprocket-headless button',
    'button[name="sr-headless-button"]',
    '.shopify-payment-button__button--unbranded',
    '.shopify-payment-button__button',
  ].join(', ');

  /** How long a Buy now tap waits for the checkout app's button to turn up. */
  static buyNowWaitMs = 4000;

  /** After page load, how long to wait for that button before hiding the sticky copy. */
  static buyNowGiveUpMs = 6000;

  /** @type {AbortController} */
  #abortController = new AbortController();

  /** @type {HTMLButtonElement | null} */
  #targetAddToCartButton = null;

  /**
   * The page's own buy now button, which the sticky one clicks. Rendered by the
   * checkout app (or Shopify's dynamic checkout), so it may arrive late or not at all.
   * @type {HTMLElement | null}
   */
  #targetBuyNowButton = null;

  /** @type {MutationObserver | null} */
  #buyNowObserver = null;

  /** @type {Array<(button: HTMLElement | null) => void>} */
  #buyNowWaiters = [];

  /** @type {number | undefined} */
  #buyNowGiveUpTimer;

  /** @type {ResizeObserver | null} */
  #resizeObserver = null;

  /** @type {number} */
  #currentQuantity = 1;

  connectedCallback() {
    super.connectedCallback();

    const productForm = this.#getProductForm();
    if (productForm) {
      this.#targetAddToCartButton = productForm.querySelector('[ref="addToCartButton"]');
    }

    // Always on screen, from the top of the page to the bottom.
    this.refs.stickyBar.dataset.stuck = 'true';
    this.#reserveSpace();

    const { signal } = this.#abortController;
    const target = this.closest('.shopify-section');
    target?.addEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate, { signal });
    target?.addEventListener(ThemeEvents.variantSelected, this.#handleVariantSelected, { signal });

    document.addEventListener(ThemeEvents.cartUpdate, this.#handleCartAddComplete, { signal });
    document.addEventListener(ThemeEvents.cartError, this.#handleCartAddComplete, { signal });
    document.addEventListener(ThemeEvents.quantitySelectorUpdate, this.#handleQuantityUpdate, { signal });

    this.#getInitialQuantity();
    this.#watchBuyNowButton();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#buyNowObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#abortController.abort();
    window.clearTimeout(this.#buyNowGiveUpTimer);
    this.#settleBuyNowWaiters(null);
    document.documentElement.style.removeProperty('--sticky-add-to-cart-space');
  }

  /**
   * The bar covers the bottom of the viewport, so give the page that much extra room
   * at the end (see `body { padding-bottom }` in the section stylesheet).
   */
  #reserveSpace() {
    const { stickyBar } = this.refs;
    const update = () => {
      const offset = parseFloat(getComputedStyle(stickyBar).bottom) || 0;
      const space = Math.ceil(stickyBar.offsetHeight + offset);
      document.documentElement.style.setProperty('--sticky-add-to-cart-space', `${space}px`);
    };

    this.#resizeObserver = new ResizeObserver(update);
    this.#resizeObserver.observe(stickyBar);
    window.addEventListener('resize', update, { signal: this.#abortController.signal });
    update();
  }

  // Public action handlers
  /**
   * Handles the add to cart button click in the sticky bar. The add-to-cart popup
   * confirms the result, so the bar itself doesn't animate.
   */
  handleAddToCartClick = () => {
    if (!this.#targetAddToCartButton) return;
    this.#targetAddToCartButton.dataset.puppet = 'true';
    this.#targetAddToCartButton.click();
  };

  /**
   * Handles the buy now button click in the sticky bar by clicking the page's own buy
   * now button, so the checkout app keeps ownership of the flow (variant, quantity,
   * discounts and analytics all come from the form it already reads). A tap that
   * lands before the checkout app has rendered its button waits for it.
   */
  handleBuyNowClick = async () => {
    const { buyNowButton } = this.refs;
    let target = this.#resolveBuyNowButton();

    if (!target && buyNowButton) {
      buyNowButton.setAttribute('aria-busy', 'true');
      target = await this.#waitForBuyNowButton(StickyAddToCartComponent.buyNowWaitMs);
      buyNowButton.removeAttribute('aria-busy');
    }

    if (!target) return;
    target.dataset.puppet = 'true';
    target.click();
  };

  /**
   * Finds the page's buy now button and brings the sticky copy in line with it.
   * @returns {HTMLElement | null}
   */
  #resolveBuyNowButton() {
    const { buyNowButton } = this.refs;
    if (!buyNowButton) return null;

    const productForm = this.#getProductForm();
    const scope = productForm?.closest('.buy-buttons-block') ?? productForm;

    this.#targetBuyNowButton = /** @type {HTMLElement | null} */ (
      scope?.querySelector(StickyAddToCartComponent.buyNowSelector) ?? null
    );

    if (this.#targetBuyNowButton) {
      buyNowButton.hidden = false;
      this.#copyPaymentIcons(this.#targetBuyNowButton);
      this.#settleBuyNowWaiters(this.#targetBuyNowButton);
    }

    return this.#targetBuyNowButton;
  }

  /**
   * Shows the same payment icons as the checkout app's button (Shiprocket's UPI badges).
   * @param {HTMLElement} source
   */
  #copyPaymentIcons(source) {
    const { buyNowButton } = this.refs;
    if (!buyNowButton || buyNowButton.querySelector('.sticky-add-to-cart__pay')) return;

    const icons = source.querySelector('img.sr-payment-icons');
    const src = icons?.getAttribute('src');
    if (!src) return;

    const img = document.createElement('img');
    img.className = 'sticky-add-to-cart__pay';
    img.src = src;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    buyNowButton.appendChild(img);
  }

  /**
   * @param {number} timeout
   * @returns {Promise<HTMLElement | null>}
   */
  #waitForBuyNowButton(timeout) {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.#buyNowWaiters = this.#buyNowWaiters.filter((waiter) => waiter !== done);
        resolve(null);
      }, timeout);
      /** @param {HTMLElement | null} button */
      const done = (button) => {
        window.clearTimeout(timer);
        resolve(button);
      };
      this.#buyNowWaiters.push(done);
    });
  }

  /** @param {HTMLElement | null} button */
  #settleBuyNowWaiters(button) {
    const waiters = this.#buyNowWaiters;
    this.#buyNowWaiters = [];
    waiters.forEach((done) => done(button));
  }

  /**
   * Checkout apps inject their button after the page has rendered, so keep looking
   * until it turns up. If it never does, hide the sticky copy: a button that leads
   * nowhere is worse than no button at all.
   */
  #watchBuyNowButton() {
    const { buyNowButton } = this.refs;
    if (!buyNowButton) return;

    // Done once the button is found and its payment icons copied (Shiprocket fills
    // the button in after inserting it).
    const settled = () => !!this.#resolveBuyNowButton() && !!buyNowButton.querySelector('.sticky-add-to-cart__pay');
    if (settled()) return;

    const productForm = this.#getProductForm();
    const scope = productForm?.closest('.buy-buttons-block') ?? productForm;
    if (scope) {
      this.#buyNowObserver = new MutationObserver(() => {
        if (settled()) this.#buyNowObserver?.disconnect();
      });
      this.#buyNowObserver.observe(scope, { childList: true, subtree: true });
    }

    const giveUp = () => {
      this.#buyNowGiveUpTimer = window.setTimeout(() => {
        this.#buyNowObserver?.disconnect();
        if (!this.#targetBuyNowButton && this.refs.buyNowButton) this.refs.buyNowButton.hidden = true;
      }, StickyAddToCartComponent.buyNowGiveUpMs);
    };
    if (document.readyState === 'complete') giveUp();
    else window.addEventListener('load', giveUp, { once: true, signal: this.#abortController.signal });
  }

  /**
   * Handles variant update events
   * @param {CustomEvent} event - The variant update event
   */
  #handleVariantUpdate = (event) => {
    if (event.detail.data.productId !== this.dataset.productId) return;

    const variant = event.detail.resource;

    // Get the new sticky add to cart HTML from the server response
    const newStickyAddToCart = event.detail.data.html.querySelector('sticky-add-to-cart');
    if (!newStickyAddToCart) return;

    const newStickyBar = newStickyAddToCart.querySelector('[ref="stickyBar"]');
    if (!newStickyBar) return;

    // Morph the sticky bar content (button labels, sold out state)
    morph(this.refs.stickyBar, newStickyBar, { childrenOnly: true });

    this.refs.stickyBar.dataset.stuck = 'true';
    this.dataset.variantAvailable = newStickyAddToCart.dataset.variantAvailable;

    if (variant && variant.id) {
      this.dataset.currentVariantId = variant.id;
    } else {
      this.dataset.currentVariantId = '';
    }

    // Re-cache the target add to cart button after morphing
    const productForm = this.#getProductForm();
    if (productForm) {
      this.#targetAddToCartButton = productForm.querySelector('[ref="addToCartButton"]');
    }

    // The morph drops the copied payment icons; restore them.
    this.#resolveBuyNowButton();

    // Restore the current quantity display if needed
    this.#updateButtonText();
  };

  /**
   * Handles variant selected events
   * @param {CustomEvent} event - The variant selected event
   */
  #handleVariantSelected = (event) => {
    // The variant update event will follow and handle all updates via morph
    // We just update the dataset here for tracking
    const variantId = event.detail.resource?.id;
    if (!variantId) return;
    this.dataset.currentVariantId = variantId;
  };

  /**
   * Handles cart add complete (success or error) - resets puppet flag
   * @param {CustomEvent} _event - The cart event (unused)
   */
  #handleCartAddComplete = (_event) => {
    // Reset the puppet flag after cart operation
    if (this.#targetAddToCartButton) {
      this.#targetAddToCartButton.dataset.puppet = 'false';
    }
  };

  /**
   * Handles quantity selector update events
   * @param {QuantitySelectorUpdateEvent} event - The quantity update event
   */
  #handleQuantityUpdate = (event) => {
    // Only respond to product page quantity selector updates, not cart drawer
    if (event.detail.cartLine) return;

    this.#currentQuantity = event.detail.quantity;
    this.#updateButtonText();
  };

  // Helper methods
  /**
   * Gets the product form element
   * @returns {HTMLElement | null}
   */
  #getProductForm() {
    const productId = this.dataset.productId;
    if (!productId) return null;

    const sectionElement = this.closest('.shopify-section');
    if (!sectionElement) return null;

    const sectionId = sectionElement.id.replace('shopify-section-', '');
    return document.querySelector(
      `#shopify-section-${sectionId} product-form-component[data-product-id="${productId}"]`
    );
  }

  /**
   * Gets the initial quantity from the data attribute
   */
  #getInitialQuantity() {
    this.#currentQuantity = parseInt(this.dataset.initialQuantity || '1') || 1;
    this.#updateButtonText();
  }

  /**
   * Updates the button text to include quantity
   */
  #updateButtonText() {
    const { addToCartButton, quantityDisplay, quantityNumber } = this.refs;

    const available = !addToCartButton.disabled;

    // Update the quantity number
    quantityNumber.textContent = this.#currentQuantity.toString();

    // Show/hide the quantity display based on availability and quantity
    if (available && this.#currentQuantity > 1) {
      quantityDisplay.style.display = 'inline';
    } else {
      quantityDisplay.style.display = 'none';
    }
  }
}

if (!customElements.get('sticky-add-to-cart')) {
  customElements.define('sticky-add-to-cart', StickyAddToCartComponent);
}
